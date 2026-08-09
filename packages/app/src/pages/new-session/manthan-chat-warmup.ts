import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Binary } from "@opencode-ai/core/util/binary"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { sendFollowupDraft } from "@/components/prompt-input/submit"
import type { PromptInputV2ComposerController } from "@/components/prompt-input-v2"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { useTabs } from "@/context/tabs"
import { Identifier } from "@/utils/id"
import { normalizeSessionInfo } from "@/utils/session"
import { showToast } from "@/utils/toast"
import { subscribeManthanPromptProgress } from "./manthan-prompt-progress"

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

const warmedDrafts = new Set<string>()

function isManthanProvider(providerID: string | undefined): boolean {
  if (!providerID) return false
  const s = providerID.toLowerCase()
  return s === "manthan" || s.startsWith("manthan/") || s.includes("manthan")
}

function formatWarmupProgressLine(label: string, percent: number | null | undefined): string {
  const base = String(label ?? "").replace(/\s*\(\d+%\)\s*$/, "").trim()
  if (percent == null || !Number.isFinite(percent)) return base || "Preparing chat…"
  return `${base || "Preparing chat…"} (${Math.round(percent)}%)`
}

function isPrefillStage(stage: string | null | undefined): boolean {
  if (!stage) return true
  return stage === "prompt_eval" || stage === "model_loading" || stage === "queue" || stage === "routing"
}

function warmupEnabled(): boolean {
  if (typeof window === "undefined") return false
  const raw = (window as unknown as { __OPENCODE_MANTHAN_CHAT_WARMUP?: string }).__OPENCODE_MANTHAN_CHAT_WARMUP
  if (raw != null) return !/^(0|false|off|no)$/i.test(String(raw))
  return true
}

function pickWarmupLine(): string {
  return WARMUP_LINES[Math.floor(Math.random() * WARMUP_LINES.length)]!
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message
  }
  return "Warmup failed"
}

/**
 * On New Chat with a Manthan model: create session, send a short greeting to
 * pay the tools/system prefill once, show a % loader, then unlock chat.
 */
export function useManthanChatWarmup(input: {
  controller: PromptInputV2ComposerController
  promptReady: () => boolean
}) {
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const layout = useLayout()
  const tabs = useTabs()
  const navigate = useNavigate()
  const language = useLanguage()
  const [search] = useSearchParams<{ draftId?: string }>()

  const [active, setActive] = createSignal(false)
  const [percent, setPercent] = createSignal<number | null>(null)
  const [label, setLabel] = createSignal("Preparing chat…")
  const [line, setLine] = createSignal<string | null>(null)
  const [tokenLabel, setTokenLabel] = createSignal<string | null>(null)
  const hasPercent = createMemo(() => percent() != null)

  const draftKey = createMemo(() => search.draftId || `dir:${sdk().directory}`)

  /** Primitive deps only — avoid re-running (and cancelling) on object identity churn. */
  const manthanModelKey = createMemo(() => {
    const model = input.controller.model.selection.current()
    if (!model || !isManthanProvider(model.provider.id)) return null
    return `${model.provider.id}/${model.id}`
  })

  createEffect(() => {
    if (!warmupEnabled()) return
    if (!input.promptReady()) return
    const modelKey = manthanModelKey()
    if (!modelKey) return
    const key = draftKey()
    if (warmedDrafts.has(key)) return

    // Mark before any signal writes so a re-entry cannot double-start.
    warmedDrafts.add(key)

    const hello = pickWarmupLine()
    let timeoutId: number | undefined
    let cancelled = false
    let unsubProgress: (() => void) | undefined

    onCleanup(() => {
      cancelled = true
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      unsubProgress?.()
    })

    // UI updates must not be effect dependencies (would re-run + cancel via onCleanup).
    untrack(() => {
      setActive(true)
      setPercent(null)
      setLabel("Starting Manthan…")
      setLine(hello)
    })

    void (async () => {
      try {
        const model = untrack(() => input.controller.model.selection.current())
        const agent = untrack(() => local.agent.current())
        if (!model || !agent) throw new Error("No agent or model selected")
        if (`${model.provider.id}/${model.id}` !== modelKey) throw new Error("Model changed during warmup")

        const sessionDirectory = sdk().directory
        const agentVariant = untrack(() => local.agent.current()?.variant)
        const selectedVariant =
          (agentVariant && agentVariant !== "default" ? agentVariant : undefined) ??
          untrack(() => input.controller.model.selection.variant.current())

        untrack(() => setLabel("Creating session…"))

        const created = await sdk()
          .api.session.create({
            agent: agent.name,
            model: {
              id: model.id,
              providerID: model.provider.id,
              variant: selectedVariant,
            },
            location: { directory: sessionDirectory },
          })
          .then(normalizeSessionInfo)

        if (cancelled) return

        unsubProgress = subscribeManthanPromptProgress((p) => {
          if (p.sessionID !== created.id) return
          let pct: number | null = null
          if (isPrefillStage(p.stage)) {
            if (p.percent != null) pct = Math.max(0, Math.min(99, p.percent))
            if (
              p.prompt_tokens != null &&
              p.prompt_tokens_processed != null &&
              p.prompt_tokens > p.prompt_tokens_processed &&
              p.prompt_tokens > 0
            ) {
              pct = Math.max(0, Math.min(99, Math.round((100 * p.prompt_tokens_processed) / p.prompt_tokens)))
            }
          }
          untrack(() => {
            const nextPct = pct ?? percent()
            const nextLabel = p.message || label()
            if (pct != null) setPercent(pct)
            setTokenLabel(null)
            if (p.message) setLabel(p.message)
            setLine(formatWarmupProgressLine(nextLabel, nextPct))
          })
        })

        serverSync().session.remember(created)
        const [, setStore] = serverSync().child(sessionDirectory)
        setStore("session", (list: Session[]) => {
          const result = Binary.search(list, created.id, (item) => item.id)
          const next = list.slice()
          if (result.found) {
            next[result.index] = created
            return next
          }
          next.splice(result.index, 0, created)
          return next
        })

        // Stay on New Chat until warm finishes — navigating early unmounts this hook.
        untrack(() => setLabel("Warming model (first chat pays tools+system)…"))

        const text = hello
        const prompt = [{ type: "text" as const, content: text, start: 0, end: text.length }]
        const messageID = Identifier.ascending("message")

        const promptPromise = sendFollowupDraft({
          api: sdk().api.session,
          sync: sync(),
          serverSync: serverSync(),
          draft: {
            sessionID: created.id,
            sessionDirectory,
            prompt,
            context: [],
            agent: agent.name,
            model: { modelID: model.id, providerID: model.provider.id },
            variant: selectedVariant,
          },
          messageID,
          optimisticBusy: true,
        })

        const timeout = new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(() => reject(new Error("Warmup timed out")), WARMUP_TIMEOUT_MS)
        })

        await Promise.race([promptPromise, timeout])
        if (timeoutId !== undefined) {
          window.clearTimeout(timeoutId)
          timeoutId = undefined
        }
        if (cancelled) return

        const idleDeadline = Date.now() + 30_000
        while (Date.now() < idleDeadline) {
          const status = serverSync().session.data.session_status[created.id]?.type ?? "idle"
          if (status === "idle") break
          await new Promise((r) => setTimeout(r, 250))
        }

        untrack(() => setLabel("Ready"))
        await new Promise((r) => setTimeout(r, 350))
        if (cancelled) return

        local.session.promote(sessionDirectory, created.id, {
          agent: agent.name,
          model: { providerID: model.provider.id, modelID: model.id },
          variant: selectedVariant ?? null,
        })
        layout.handoff.setTabs(base64Encode(sessionDirectory), created.id)
        const draftID = search.draftId
        if (draftID) {
          tabs.promoteDraft(draftID, { server: tabs.draft(draftID).server, sessionId: created.id })
        } else {
          navigate(`/${base64Encode(sessionDirectory)}/session/${created.id}`)
        }
      } catch (err) {
        // Keep key in warmedDrafts so we don't tight-loop; new draftId = retry.
        if (!cancelled) {
          showToast({
            title: language.t("prompt.toast.promptSendFailed.title"),
            description: errorMessage(err),
          })
        }
      } finally {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId)
        if (!cancelled) {
          untrack(() => {
            setActive(false)
            setPercent(null)
            setLine(null)
            setTokenLabel(null)
          })
        }
      }
    })()
  })

  return {
    active,
    percent,
    hasPercent,
    label,
    line,
    tokenLabel,
    disabled: active,
  }
}
