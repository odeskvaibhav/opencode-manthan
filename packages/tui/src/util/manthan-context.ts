/**
 * Read Manthan Phase-2 context from session.metadata (written by opencode CLI).
 * Kept local to @opencode-ai/tui — no dependency on packages/opencode.
 */

import { number as compactNumber } from "./locale"

/** Provider id looks like Manthan (matches packages/opencode provider/manthan). */
export function isManthanProviderID(id: string | undefined | null): boolean {
  if (!id) return false
  const s = id.toLowerCase()
  return s === "manthan" || s.startsWith("manthan/") || /(^|\/)manthan(\/|$)/.test(s)
}

/** True when a Manthan provider id is present (models may still be empty / loading). */
export function hasManthanProvider(providers: readonly { id: string }[]): boolean {
  return providers.some((p) => isManthanProviderID(p.id))
}

/** VS Code / `opencode-manthan.sh` set this so TUI can treat the session as Manthan-first. */
export function isManthanLaunchMode(): boolean {
  const raw = process.env.OPENCODE_MANTHAN_MODE
  return raw === "1" || raw === "true"
}

export function gpuWakeLabel(status: string | undefined): string {
  if (!status || status === "ready") return ""
  if (status === "capped") return "GPU cap reached — queued"
  if (status === "queued") return "Queued for GPU…"
  return "Waking GPU…"
}

/** Prefer API `phase` (PROVISIONING/BOOTING/AGENT) over coarse status. */
export function gpuWakePhaseLabel(input: {
  status?: string
  phase?: string | null
  phaseInstance?: string | null
  lastError?: { message?: string } | null
}): string {
  const name = input.phaseInstance?.trim()
  const suffix = name ? ` (${name})` : ""
  const phase = (input.phase || "").toLowerCase()
  if (phase === "ready" || input.status === "ready") return ""
  // Phase wins: status can still say capped while a VM is provisioning.
  if (phase === "provisioning") return `Creating GPU VM…${suffix}`
  if (phase === "booting") return `GPU VM booting…${suffix}`
  if (phase === "agent") return `Loading model on GPU…${suffix}`
  if (phase === "error") {
    const msg = input.lastError?.message?.trim()
    return msg ? `GPU error: ${msg.slice(0, 80)}` : "GPU error — check Fleet"
  }
  if (phase === "capped" || input.status === "capped") return "GPU cap reached — queued"
  if (phase === "queued" || input.status === "queued") return "Queued for GPU…"
  return name ? `Waking GPU…${suffix}` : "Waking GPU…"
}

/** POST /v1/workers/ensure-ready after the user picks a Manthan model (not on picker open). */
export function manthanEnsureReadyRequest(provider: {
  id: string
  key?: string
  options?: Record<string, unknown>
}): { url: string; headers: Record<string, string> } | null {
  if (!isManthanProviderID(provider.id)) return null
  const opts = provider.options ?? {}
  const base = typeof opts.baseURL === "string" ? opts.baseURL.replace(/\/+$/, "") : ""
  if (!base) return null
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" }
  if (opts.headers && typeof opts.headers === "object") {
    for (const [k, v] of Object.entries(opts.headers as Record<string, unknown>)) {
      if (typeof v === "string" && v) headers[k] = v
    }
  }
  const apiKey = typeof opts.apiKey === "string" ? opts.apiKey : provider.key
  const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization")
  if (apiKey && !hasAuth) headers.Authorization = `Bearer ${apiKey}`
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "x-manthan-client")) {
    headers["X-Manthan-Client"] = "opencode"
  }
  return { url: `${base}/workers/ensure-ready`, headers }
}

let gpuHeartbeat: ReturnType<typeof setInterval> | null = null

export function wakeManthanGpuFromProvider(provider: {
  id: string
  key?: string
  options?: Record<string, unknown>
}): void {
  const req = manthanEnsureReadyRequest(provider)
  if (!req) return
  void fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify({ reason: "launch" }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => undefined)
  startManthanGpuHeartbeat(provider)
}

export function startManthanGpuHeartbeat(provider: {
  id: string
  key?: string
  options?: Record<string, unknown>
}): void {
  if (gpuHeartbeat) return
  const req = manthanEnsureReadyRequest(provider)
  if (!req) return
  gpuHeartbeat = setInterval(() => {
    void fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify({ reason: "heartbeat" }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined)
  }, 30_000)
  if (typeof gpuHeartbeat === "object" && gpuHeartbeat && "unref" in gpuHeartbeat) {
    gpuHeartbeat.unref()
  }
}

export function stopManthanGpuHeartbeat(): void {
  if (gpuHeartbeat) clearInterval(gpuHeartbeat)
  gpuHeartbeat = null
}

/** OpenCode process exiting — drop wake so the reconciler does not spawn another G4. */
export function leaveManthanGpuFromProvider(provider: {
  id: string
  key?: string
  options?: Record<string, unknown>
}): void {
  stopManthanGpuHeartbeat()
  const req = manthanEnsureReadyRequest(provider)
  if (!req) return
  void fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify({ reason: "leave" }),
    signal: AbortSignal.timeout(3000),
    keepalive: true,
  }).catch(() => undefined)
}

/** Cold G4 + vLLM load often exceeds 4–8 min. */
export const GPU_WAIT_MS = 12 * 60_000
/** Prefill timeout; reset on each prompt_progress event. */
export const WARMUP_IDLE_MS = 8 * 60_000

export async function waitForManthanGpuFromProvider(
  provider: { id: string; key?: string; options?: Record<string, unknown> },
  opts?: {
    timeoutMs?: number
    pollMs?: number
    cancelled?: () => boolean
    onStatus?: (label: string) => void
  },
): Promise<"ready" | "capped" | "timeout"> {
  const req = manthanEnsureReadyRequest(provider)
  if (!req) return "ready"
  const deadline = Date.now() + (opts?.timeoutMs ?? GPU_WAIT_MS)
  const pollMs = opts?.pollMs ?? 2000
  let first = true
  while (Date.now() < deadline) {
    if (opts?.cancelled?.()) return "timeout"
    try {
      const res = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify({ reason: first ? "launch" : "heartbeat" }),
        signal: AbortSignal.timeout(8000),
      })
      first = false
      if (res.ok) {
        const body = (await res.json()) as {
          status?: string
          ready?: boolean
          phase?: string
          phaseInstance?: string | null
          lastError?: { message?: string } | null
        }
        if (body.ready === true || body.status === "ready") return "ready"
        // Hard cap only when nothing is provisioning (phase wins over stale status).
        const wakePhases = new Set(["provisioning", "booting", "agent", "waking"])
        if (
          (body.phase === "capped" || body.status === "capped") &&
          !wakePhases.has(String(body.phase || ""))
        ) {
          opts?.onStatus?.(gpuWakePhaseLabel({ status: "capped", phase: "capped" }))
          return "capped"
        }
        const line = gpuWakePhaseLabel({
          status: body.status,
          phase: body.phase,
          phaseInstance: body.phaseInstance,
          lastError: body.lastError,
        })
        if (line) opts?.onStatus?.(line)
      }
    } catch {
      /* retry until deadline */
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return "timeout"
}

/** First connected Manthan provider with at least one model. */
export function findManthanProvider<T extends { id: string; models: Record<string, unknown> }>(
  providers: readonly T[],
): T | undefined {
  return providers.find((p) => isManthanProviderID(p.id) && Object.keys(p.models).length > 0)
}

export type ManthanCompactMarker = {
  messageID: string
  epoch: number
  at: number
  summary?: string
}

export type ManthanContextUsage = {
  context_limit: number | null
  context_used: number | null
  context_usable: number | null
  context_remaining: number | null
  context_usage_percent: number | null
  compaction_threshold: number | null
  compaction_status: string | null
  cache_epoch: number | null
  newly_evaluated_tokens: number | null
  cache_reuse_percent: number | null
  compact_summary: string | null
  compact_markers: ManthanCompactMarker[]
  compact_reason: string | null
  compact_usage_before_percent: number | null
  updated_at: number | null
}

function parseCompactMarkers(raw: unknown): ManthanCompactMarker[] {
  if (!Array.isArray(raw)) return []
  const out: ManthanCompactMarker[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const o = item as Record<string, unknown>
    if (typeof o.messageID !== "string" || !o.messageID) continue
    const summary = typeof o.summary === "string" ? o.summary.trim() : ""
    out.push({
      messageID: o.messageID,
      epoch: typeof o.epoch === "number" && Number.isFinite(o.epoch) ? Math.floor(o.epoch) : 0,
      at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0,
      ...(summary ? { summary } : {}),
    })
  }
  return out
}

export function manthanContextFromMetadata(
  metadata: Record<string, unknown> | undefined | null,
): ManthanContextUsage | null {
  const raw = metadata?.manthan
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  if (o.context_used == null && o.context_usage_percent == null && o.context_limit == null) return null
  return {
    context_limit: typeof o.context_limit === "number" ? o.context_limit : null,
    context_used: typeof o.context_used === "number" ? o.context_used : null,
    context_usable: typeof o.context_usable === "number" ? o.context_usable : null,
    context_remaining: typeof o.context_remaining === "number" ? o.context_remaining : null,
    context_usage_percent: typeof o.context_usage_percent === "number" ? o.context_usage_percent : null,
    compaction_threshold: typeof o.compaction_threshold === "number" ? o.compaction_threshold : null,
    compaction_status: typeof o.compaction_status === "string" ? o.compaction_status : null,
    cache_epoch: typeof o.cache_epoch === "number" ? o.cache_epoch : null,
    newly_evaluated_tokens: typeof o.newly_evaluated_tokens === "number" ? o.newly_evaluated_tokens : null,
    cache_reuse_percent: typeof o.cache_reuse_percent === "number" ? o.cache_reuse_percent : null,
    compact_summary: typeof o.compact_summary === "string" ? o.compact_summary.trim() || null : null,
    compact_markers: parseCompactMarkers(o.compact_markers),
    compact_reason: typeof o.compact_reason === "string" ? o.compact_reason : null,
    compact_usage_before_percent:
      typeof o.compact_usage_before_percent === "number" && Number.isFinite(o.compact_usage_before_percent)
        ? o.compact_usage_before_percent
        : null,
    updated_at: typeof o.updated_at === "number" && Number.isFinite(o.updated_at) ? o.updated_at : null,
  }
}

export function manthanCompactDividerForMessage(
  messageID: string,
  usage: ManthanContextUsage | null | undefined,
): boolean {
  return usage?.compact_markers.some((m) => m.messageID === messageID) ?? false
}

export function manthanCompactSummaryForMessage(
  messageID: string,
  usage: ManthanContextUsage | null | undefined,
): string | null {
  const text = usage?.compact_markers.find((m) => m.messageID === messageID)?.summary?.trim()
  return text || null
}

/** Honest UX copy: child sessions condensed their own context, not the parent's. */
export function manthanSummarisedLabel(isSubagent: boolean): string {
  return isSubagent ? "Subagent context summarised" : "Chat context summarised"
}

export function manthanHasSummarised(usage: ManthanContextUsage | null | undefined): boolean {
  if (!usage) return false
  return (
    usage.compaction_status === "compacted" ||
    usage.compact_markers.length > 0 ||
    Boolean(usage.compact_summary?.trim())
  )
}

export function manthanLatestSummary(usage: ManthanContextUsage | null | undefined): string | null {
  if (!usage) return null
  return (
    usage.compact_summary?.trim() ||
    [...usage.compact_markers].reverse().find((m) => m.summary?.trim())?.summary?.trim() ||
    null
  )
}

/** True when this user turn should show the Cursor-style summarised divider. */
export function manthanCompactAnchorForMessage(
  messageID: string,
  userMessageIDs: string[],
  usage: ManthanContextUsage | null | undefined,
): { show: boolean; summary: string | null } {
  if (!usage) return { show: false, summary: null }
  const direct = usage.compact_markers.find((m) => m.messageID === messageID)
  if (direct) {
    return {
      show: true,
      summary: direct.summary?.trim() || manthanLatestSummary(usage),
    }
  }

  const matched = new Set(usage.compact_markers.map((m) => m.messageID))
  if (!manthanHasSummarised(usage)) return { show: false, summary: null }
  if (userMessageIDs.some((id) => matched.has(id))) return { show: false, summary: null }
  const lastUser = userMessageIDs.at(-1)
  if (lastUser !== messageID) return { show: false, summary: null }
  return { show: true, summary: manthanLatestSummary(usage) }
}

export function formatContextBar(input: {
  used: number | null
  limit: number | null
  percent: number | null
  compactAt?: number | null
  status?: string | null
  compactedFromPercent?: number | null
}): string | undefined {
  const { used, limit, percent, compactAt, status, compactedFromPercent } = input
  if (used == null && percent == null && limit == null) return undefined
  const usedLabel = used != null ? compactNumber(used) : "?"
  const limitLabel = limit != null && limit > 0 ? compactNumber(limit) : null
  let main = limitLabel ? `${usedLabel} / ${limitLabel}` : usedLabel
  if (percent != null) main += ` (${Math.round(percent)}%)`
  if (compactAt != null && Number.isFinite(compactAt)) main += ` · compact@${Math.round(compactAt)}%`
  if (status === "compacted") {
    if (compactedFromPercent != null && Number.isFinite(compactedFromPercent)) {
      main += ` · compacted from ${Math.round(compactedFromPercent)}%`
    } else {
      main += ` · compacted`
    }
  }
  return main
}

/**
 * compact@ is a model/policy value, not per-session usage. Parent + child footers
 * used to diverge when one session had stale metadata (e.g. 80 vs 50).
 * Keep the freshest Manthan threshold process-wide so all footers match.
 */
let sharedCompactionThreshold: number | null = null
let sharedCompactionAt = 0
const sharedCompactionListeners = new Set<() => void>()

export function noteSharedCompactionThreshold(
  threshold: number | null | undefined,
  at: number | null | undefined = Date.now(),
): void {
  if (threshold == null || !Number.isFinite(threshold) || threshold <= 0) return
  const next = Math.round(threshold)
  const when = at != null && Number.isFinite(at) && at > 0 ? at : Date.now()
  if (sharedCompactionThreshold === next) {
    if (when > sharedCompactionAt) sharedCompactionAt = when
    return
  }
  // Ignore older snapshots so a stale parent (80) cannot overwrite a fresh child (50).
  if (sharedCompactionAt > 0 && when < sharedCompactionAt) return
  sharedCompactionAt = when
  sharedCompactionThreshold = next
  for (const fn of sharedCompactionListeners) fn()
}

export function getSharedCompactionThreshold(): number | null {
  return sharedCompactionThreshold
}

export function subscribeSharedCompactionThreshold(fn: () => void): () => void {
  sharedCompactionListeners.add(fn)
  return () => {
    sharedCompactionListeners.delete(fn)
  }
}

/** Test helper. */
export function clearSharedCompactionThreshold(): void {
  sharedCompactionThreshold = null
  sharedCompactionAt = 0
}

export function resolveCompactionThreshold(
  sessionThreshold: number | null | undefined,
  modelThreshold?: number | null,
  at?: number | null,
): number | null {
  noteSharedCompactionThreshold(sessionThreshold, at)
  noteSharedCompactionThreshold(modelThreshold, at)
  return (
    getSharedCompactionThreshold() ??
    (sessionThreshold != null && Number.isFinite(sessionThreshold)
      ? Math.round(sessionThreshold)
      : modelThreshold != null && Number.isFinite(modelThreshold)
        ? Math.round(modelThreshold)
        : null)
  )
}

export function formatManthanContextLabel(usage: ManthanContextUsage): string | undefined {
  return formatContextBar({
    used: usage.context_used,
    limit: usage.context_limit,
    percent: usage.context_usage_percent,
    compactAt: resolveCompactionThreshold(usage.compaction_threshold, null, usage.updated_at),
    status: usage.compaction_status,
    compactedFromPercent: usage.compact_usage_before_percent,
  })
}

export function compactAtFromModel(model: { options?: Record<string, unknown> } | null | undefined): number | null {
  const v = model?.options?.compaction_threshold
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null
}

/** Warmup line: keep rotating API copy, sticky percent in brackets. */
export function formatWarmupProgressLine(label: string, percent: number | null | undefined): string {
  const base = String(label ?? "").replace(/\s*\(\d+%\)\s*$/, "").trim()
  if (percent == null || !Number.isFinite(percent)) return base || "Preparing chat…"
  return `${base || "Preparing chat…"} (${Math.round(percent)}%)`
}

/** Loader copy while New Chat prefill runs (API events often never reach TUI). */
export const WARMUP_ROTATE_LINES = [
  "Warming up the silicon…",
  "Waiting for a free brain cell…",
  "Finding the least sleepy worker…",
  "Loading the big brain…",
  "Summoning the weights…",
  "Reading the room. And the repository.",
  "Digesting several thousand tokens…",
  "Parsing your beautiful pile of context…",
  "Thinking before touching production. Rare, but useful.",
  "Connecting the architectural dots…",
  "GPUs are stretching.",
  "The tokens are tokening.",
] as const

export function nextWarmupRotateLine(prev?: string | null): (typeof WARMUP_ROTATE_LINES)[number] {
  const strip = String(prev ?? "")
    .replace(/\s*\(\d+%\)$/, "")
    .trim()
  const candidates = strip ? WARMUP_ROTATE_LINES.filter((m) => m !== strip) : [...WARMUP_ROTATE_LINES]
  const list = candidates.length > 0 ? candidates : WARMUP_ROTATE_LINES
  return list[Math.floor(Math.random() * list.length)] ?? WARMUP_ROTATE_LINES[0]!
}
