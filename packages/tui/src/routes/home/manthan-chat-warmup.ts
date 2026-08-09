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
import { formatWarmupProgressLine } from "../../util/manthan-context"

const WARMUP_LINES = [
  "hi",
  "hey",
  "hello",
  "yo — ready when you are",
  "hey there",
  "good to go?",
  "hi — just getting set up",
]

const WARMUP_TIMEOUT_MS = 4 * 60_000

function isManthanProvider(providerID: string | undefined): boolean {
  if (!providerID) return false
  const s = providerID.toLowerCase()
  return s === "manthan" || s.startsWith("manthan/") || s.includes("manthan")
}

function warmupEnabled(): boolean {
  const raw = process.env.OPENCODE_MANTHAN_CHAT_WARMUP ?? process.env.MANTHAN_CHAT_WARMUP
  if (raw != null) return !/^(0|false|off|no)$/i.test(String(raw))
  return true
}

function pickWarmupLine(): string {
  return WARMUP_LINES[Math.floor(Math.random() * WARMUP_LINES.length)]!
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
 * On TUI home (New session) with a Manthan model: create session, send a short
 * greeting to pay tools/system prefill once, show a % loader, then open the session.
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
  let unsubProgress: (() => void) | undefined

  onCleanup(() => {
    cancelled = true
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    unsubProgress?.()
  })

  const manthanModelKey = createMemo(() => {
    const model = local.model.current()
    if (!model || !isManthanProvider(model.providerID)) return null
    return `${model.providerID}/${model.modelID}`
  })

  createEffect(() => {
    if (!warmupEnabled()) return
    // CLI --prompt owns the first turn; don't steal it with warmup.
    if (args.prompt) return
    if (!sync.ready || !local.model.ready) return
    const modelKey = manthanModelKey()
    if (!modelKey) return
    if (started) return
    started = true

    const hello = pickWarmupLine()

    untrack(() => {
      setActive(true)
      setPercent(null)
      setLabel("Starting Manthan…")
      setTokenLabel(null)
    })

    void (async () => {
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

        const dest = untrack(() => destination?.destination())
        const directory =
          dest?.type === "directory" ? dest.directory : sync.path.directory || paths.cwd

        untrack(() => setLabel("Creating session…"))

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

        const sessionID = res.data.id

        unsubProgress = event.subscribe((evt) => {
          if ((evt as { type?: string }).type !== "manthan.prompt_progress") return
          const p = (evt as { properties?: ProgressProps }).properties
          if (!p || p.sessionID !== sessionID) return
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

        untrack(() => setLabel("Warming model (first chat pays tools+system)…"))

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
          timeoutId = setTimeout(() => reject(new Error("Warmup timed out")), WARMUP_TIMEOUT_MS)
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

        untrack(() => setLabel("Ready"))
        await new Promise((r) => setTimeout(r, 350))
        if (cancelled) return

        route.navigate({ type: "session", sessionID })
      } catch (err) {
        if (!cancelled) {
          toast.show({
            title: "Manthan warmup failed",
            message: errorMessage(err),
            variant: "error",
          })
        }
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId)
          timeoutId = undefined
        }
        unsubProgress?.()
        unsubProgress = undefined
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
