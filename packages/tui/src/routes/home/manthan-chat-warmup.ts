import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { useArgs } from "../../context/args"
import { useEvent } from "../../context/event"
import { useLocal } from "../../context/local"
import { useRoute } from "../../context/route"
import { useSDK } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { useTuiPaths } from "../../context/runtime"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { useHomeSessionDestination } from "./session-destination"
import {
  formatWarmupProgressLine,
  isManthanProviderID,
  nextWarmupRotateLine,
  waitForManthanGpuFromProvider,
  WARMUP_IDLE_MS,
} from "../../util/manthan-context"

const ROTATE_MS = 2_800

const WARMUP_LINE = "Hi, what can you do for me?"

/** One auto-warmup per model per OpenCode process — session.new must not spawn another. */
const warmedModels = new Set<string>()

function warmupEnabled(): boolean {
  const raw = process.env.OPENCODE_MANTHAN_CHAT_WARMUP ?? process.env.MANTHAN_CHAT_WARMUP
  if (raw != null) return !/^(0|false|off|no)$/i.test(String(raw))
  return true
}

function pickWarmupLine(): string {
  return WARMUP_LINE
}

type ProgressProps = {
  sessionID?: string
  percent?: number | null
  prompt_tokens?: number | null
  prompt_tokens_processed?: number | null
  message?: string | null
  stage?: string | null
}

function isPrefillStage(stage: string | null | undefined): boolean {
  if (!stage) return true
  return stage === "prompt_eval" || stage === "model_loading" || stage === "queue" || stage === "routing"
}

/**
 * On TUI home (New session) with a Manthan model: create session, send a fixed
 * greeting to pay tools/system prefill once, show a % loader, then open the session.
 * Session runner keeps tools for KV prefill but forces tool_choice=none and a
 * single step so Laguna cannot bash/pwd then restate the intro.
 */
export function useManthanChatWarmup() {
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const route = useRoute()
  const event = useEvent()
  const toast = useToast()
  const args = useArgs()
  const paths = useTuiPaths()
  const destination = useHomeSessionDestination()

  const [active, setActive] = createSignal(false)
  const [percent, setPercent] = createSignal<number | null>(null)
  const [label, setLabel] = createSignal("Preparing chat…")
  const [tokenLabel, setTokenLabel] = createSignal<string | null>(null)
  const hasPercent = createMemo(() => percent() != null)

  // Per Home mount — effect re-runs must not cancel / restart warmup.
  let started = false
  let cancelled = false
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let rotateId: ReturnType<typeof setInterval> | undefined
  let unsubProgress: (() => void) | undefined

  const stopRotate = () => {
    if (rotateId !== undefined) {
      clearInterval(rotateId)
      rotateId = undefined
    }
  }

  onCleanup(() => {
    cancelled = true
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    stopRotate()
    unsubProgress?.()
  })

  const manthanModelKey = createMemo(() => {
    const model = local.model.current()
    if (!model || !isManthanProviderID(model.providerID)) return null
    return `${model.providerID}/${model.modelID}`
  })

  createEffect(() => {
    if (!warmupEnabled()) return
    // CLI --prompt owns the first turn; don't steal it with warmup.
    if (args.prompt) return
    if (!sync.ready || !local.model.ready) return
    const modelKey = manthanModelKey()
    if (!modelKey) return
    if (warmedModels.has(modelKey)) return
    if (started) return
    started = true

    const hello = pickWarmupLine()

    untrack(() => {
      setActive(true)
      setPercent(null)
      setLabel(nextWarmupRotateLine(null))
      setTokenLabel(null)
    })
    rotateId = setInterval(() => {
      untrack(() => setLabel(nextWarmupRotateLine(label())))
    }, ROTATE_MS)

    void (async () => {
      let sessionID: string | undefined
      try {
        const model = untrack(() => local.model.current())
        const agent = untrack(() => local.agent.current())
        if (!model || !agent) throw new Error("No agent or model selected")
        if (`${model.providerID}/${model.modelID}` !== modelKey) throw new Error("Model changed during warmup")

        untrack(() => local.model.variant.useAgentDefault())
        const agentVariant = untrack(() => local.agent.current()?.variant)
        const selectedVariant =
          (agentVariant && agentVariant !== "default" ? agentVariant : undefined) ??
          untrack(() => local.model.variant.current())

        stopRotate()
        untrack(() => setLabel("Waking GPU…"))
        const provider = untrack(() => sync.data.provider.find((item) => item.id === model.providerID))
        if (provider) {
          const gpu = await waitForManthanGpuFromProvider(provider, {
            cancelled: () => cancelled,
            onStatus: (line) => {
              if (line) untrack(() => setLabel(line))
            },
          })
          if (cancelled) return
          if (gpu === "capped") throw new Error("GPU cap reached — queued")
          if (gpu === "timeout") throw new Error("GPU still waking — type when Fleet is READY")
        }
        if (cancelled) return
        rotateId = setInterval(() => {
          untrack(() => setLabel(nextWarmupRotateLine(label())))
        }, ROTATE_MS)

        const dest = untrack(() => destination?.destination())
        const directory =
          dest?.type === "directory" ? dest.directory : sync.path.directory || paths.cwd

        const res = await sdk.client.session.create({
          directory,
          agent: agent.name,
          model: {
            providerID: model.providerID,
            id: model.modelID,
            variant: selectedVariant,
          },
        })

        if (res.error || !res.data?.id) {
          throw res.error ?? new Error("Creating a session failed")
        }
        if (cancelled) return

        sessionID = res.data.id

        let rejectIdle: (err: Error) => void = () => undefined
        const armIdle = () => {
          if (timeoutId !== undefined) clearTimeout(timeoutId)
          timeoutId = setTimeout(() => rejectIdle(new Error("Warmup timed out")), WARMUP_IDLE_MS)
        }

        unsubProgress = event.subscribe((evt) => {
          if ((evt as { type?: string }).type !== "manthan.prompt_progress") return
          const p = (evt as { properties?: ProgressProps }).properties
          if (!p || p.sessionID !== sessionID) return
          armIdle()
          let pct: number | null = null
          if (isPrefillStage(p.stage)) {
            if (typeof p.percent === "number") pct = Math.max(0, Math.min(99, Math.round(p.percent)))
            if (
              typeof p.prompt_tokens === "number" &&
              typeof p.prompt_tokens_processed === "number" &&
              p.prompt_tokens > p.prompt_tokens_processed &&
              p.prompt_tokens > 0
            ) {
              pct = Math.max(0, Math.min(99, Math.round((100 * p.prompt_tokens_processed) / p.prompt_tokens)))
            }
          }
          untrack(() => {
            if (pct != null) setPercent(pct)
            setTokenLabel(null)
            if (typeof p.message === "string" && p.message) setLabel(p.message)
          })
        })

        const promptPromise = sdk.client.session.prompt(
          {
            sessionID,
            agent: agent.name,
            model: {
              providerID: model.providerID,
              modelID: model.modelID,
            },
            variant: selectedVariant,
            parts: [{ type: "text", text: hello }],
          },
          { throwOnError: true },
        )

        const timeout = new Promise<never>((_, reject) => {
          rejectIdle = reject
          armIdle()
        })

        await Promise.race([promptPromise, timeout])
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId)
          timeoutId = undefined
        }
        if (cancelled) return

        const idleDeadline = Date.now() + 30_000
        while (Date.now() < idleDeadline) {
          const status = sync.data.session_status?.[sessionID]?.type ?? "idle"
          if (status === "idle") break
          await new Promise((r) => setTimeout(r, 250))
        }

        stopRotate()
        untrack(() => setLabel("Ready"))
        await new Promise((r) => setTimeout(r, 350))
        if (cancelled) return

        warmedModels.add(modelKey)
        route.navigate({ type: "session", sessionID })
      } catch (err) {
        if (!cancelled) {
          toast.show({
            title: sessionID ? "Warmup timed out" : "Manthan warmup failed",
            message: sessionID ? "Type when Fleet is READY." : errorMessage(err),
            variant: sessionID ? "warning" : "error",
          })
          if (sessionID) {
            warmedModels.add(modelKey)
            route.navigate({ type: "session", sessionID })
          }
        }
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId)
          timeoutId = undefined
        }
        unsubProgress?.()
        unsubProgress = undefined
        stopRotate()
        if (!cancelled) {
          untrack(() => {
            setActive(false)
            setPercent(null)
            setTokenLabel(null)
          })
        }
      }
    })()
  })

  const line = createMemo(() => formatWarmupProgressLine(label(), percent()))

  return {
    active,
    percent,
    hasPercent,
    label,
    tokenLabel,
    line,
    disabled: active,
  }
}
