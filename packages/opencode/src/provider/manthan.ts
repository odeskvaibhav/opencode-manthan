/**
 * Manthan Option A — Manthan owns model-facing context.
 * OpenCode must not auto-compact / LLM-summarize against Manthan.
 *
 * @see infer-pool/docs/opencode-manthan-first-class-plan.md
 */

export type ManthanConfigSlice = {
  model?: string
  provider?: Record<
    string,
    {
      name?: string
      options?: {
        baseURL?: string
        headers?: Record<string, string>
      }
    }
  >
  compaction?: {
    auto?: boolean
    prune?: boolean
    reserved?: number
    tail_turns?: number
    preserve_recent_tokens?: number
  }
}

const MANTHAN_HEADER = "x-manthan-client"

function headerLookup(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v
  }
  return undefined
}

/** Provider id or model string looks like Manthan. */
export function isManthanProviderID(id: string | undefined | null): boolean {
  if (!id) return false
  const s = id.toLowerCase()
  return s === "manthan" || s.startsWith("manthan/") || s.includes("manthan")
}

export function normalizeManthanModelId(id: string): string {
  return id.trim().replace(/^manthan\//i, "").toLowerCase()
}

export type ManthanModelPolicy = {
  context_limit: number
  compaction_threshold: number | null
}

type ManthanModelPatch = {
  id?: string
  api?: { id?: string }
  limit: { context: number }
  options?: Record<string, unknown>
}

/** Read admin compact window + % from Manthan GET /v1/models. */
export async function fetchManthanModelPolicies(input: {
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  timeoutMs?: number
}): Promise<Map<string, ManthanModelPolicy>> {
  const out = new Map<string, ManthanModelPolicy>()
  const base = input.baseURL.replace(/\/+$/, "")
  if (!base) return out
  const headers: Record<string, string> = { Accept: "application/json", ...(input.headers ?? {}) }
  if (input.apiKey && !headerLookup(headers, "authorization")) {
    headers.Authorization = `Bearer ${input.apiKey}`
  }
  const res = await fetch(`${base}/models`, {
    headers,
    signal: AbortSignal.timeout(input.timeoutMs ?? 4000),
  })
  if (!res.ok) return out
  const body = (await res.json()) as { data?: unknown[]; models?: unknown[] }
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const r = row as Record<string, unknown>
    const id = typeof r.id === "string" ? r.id : ""
    if (!id) continue
    const context_limit = Number(r.context_length ?? r.context_window ?? 0)
    const compaction_threshold = Number(r.compaction_threshold)
    out.set(normalizeManthanModelId(id), {
      context_limit: Number.isFinite(context_limit) && context_limit > 0 ? context_limit : 0,
      compaction_threshold:
        Number.isFinite(compaction_threshold) && compaction_threshold > 0 ? compaction_threshold : null,
    })
  }
  return out
}

export function applyManthanModelPolicies(
  models: Record<string, ManthanModelPatch>,
  policies: Map<string, ManthanModelPolicy>,
): number {
  let n = 0
  for (const [id, model] of Object.entries(models)) {
    const p =
      policies.get(normalizeManthanModelId(id)) ||
      (model.api?.id ? policies.get(normalizeManthanModelId(model.api.id)) : undefined) ||
      (model.id ? policies.get(normalizeManthanModelId(model.id)) : undefined)
    if (!p) continue
    if (p.context_limit > 0) {
      model.limit.context = p.context_limit
      n++
    }
    if (p.compaction_threshold != null) {
      model.options = { ...(model.options ?? {}), compaction_threshold: p.compaction_threshold }
    }
  }
  return n
}

/** Config selects Manthan as the active / configured backend. */
export function isManthanConfig(cfg: ManthanConfigSlice): boolean {
  if (process.env.OPENCODE_MANTHAN_MODE === "1" || process.env.OPENCODE_MANTHAN_MODE === "true") {
    return true
  }
  if (isManthanProviderID(cfg.model)) return true
  const providers = cfg.provider ?? {}
  for (const [id, info] of Object.entries(providers)) {
    if (isManthanProviderID(id)) return true
    if (isManthanProviderID(info?.name)) return true
    if (headerLookup(info?.options?.headers, MANTHAN_HEADER)) return true
  }
  return false
}

/**
 * Option A defaults: disable OpenCode auto-compact + prune.
 * Escape hatch: OPENCODE_MANTHAN_ALLOW_CLIENT_COMPACT=1
 */
export function applyManthanOptionA<T extends ManthanConfigSlice>(cfg: T): T {
  if (!isManthanConfig(cfg)) return cfg
  if (
    process.env.OPENCODE_MANTHAN_ALLOW_CLIENT_COMPACT === "1" ||
    process.env.OPENCODE_MANTHAN_ALLOW_CLIENT_COMPACT === "true"
  ) {
    return cfg
  }
  return {
    ...cfg,
    compaction: {
      ...cfg.compaction,
      auto: false,
      prune: false,
    },
  }
}

/** Ensure identity header is present for Manthan requests. */
export function ensureManthanClientHeaders(
  headers: Record<string, string> | undefined,
  providerID: string,
): Record<string, string> {
  const out = { ...(headers ?? {}) }
  if (!isManthanProviderID(providerID) && !headerLookup(out, MANTHAN_HEADER)) {
    return out
  }
  if (!headerLookup(out, MANTHAN_HEADER)) {
    out["x-manthan-client"] = "opencode"
  }
  return out
}

function asReasoningEffort(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  const s = v.trim().toLowerCase()
  if (!s || s === "default") return undefined
  return s
}

/**
 * Resolve Laguna/Manthan reasoning effort for a request.
 * Never leave this unset — llama/API default to `low` when the field is missing.
 */
export function manthanReasoningEffort(input: {
  userVariant?: string
  agent?: { variant?: string; options?: Record<string, any> }
  options?: Record<string, any>
  variant?: Record<string, any>
}): string {
  const header =
    input.options?.headers?.["X-Manthan-Reasoning-Effort"] ??
    input.options?.headers?.["x-manthan-reasoning-effort"] ??
    input.variant?.headers?.["X-Manthan-Reasoning-Effort"] ??
    input.variant?.headers?.["x-manthan-reasoning-effort"]
  const candidates = [
    input.userVariant,
    input.agent?.variant,
    input.agent?.options?.reasoningEffort,
    input.agent?.options?.reasoning_effort,
    input.options?.reasoning_effort,
    input.options?.reasoningEffort,
    input.variant?.reasoning_effort,
    input.variant?.reasoningEffort,
    header,
  ]
  for (const c of candidates) {
    const effort = asReasoningEffort(c)
    if (effort) return effort
  }
  return "medium"
}

/** Session affinity headers Manthan already understands. */
export function manthanSessionHeaders(sessionID: string): Record<string, string> {
  return {
    "x-manthan-client": "opencode",
    "x-opencode-session": sessionID,
    "x-opencode-session-id": sessionID,
    "x-session-affinity": sessionID,
    "X-Session-Id": sessionID,
    "X-Title": "Manthan",
    "HTTP-Referer": "https://manthan.ai",
    // Prefill % arrives as SSE comments (safe for OpenCode Zod).
    "x-manthan-progress": "comment",
  }
}

/** Live llama prefill progress for New Chat warmup UI. */
export type ManthanPromptProgress = {
  sessionID: string
  percent: number | null
  prompt_tokens: number | null
  prompt_tokens_processed: number | null
  prompt_tokens_cached: number | null
  stage: string | null
  message: string | null
  updated_at: number
}

const promptProgressBySession = new Map<string, ManthanPromptProgress>()
const promptProgressListeners = new Set<(p: ManthanPromptProgress) => void>()

function isLikelyLlamaBatchSize(n: number): boolean {
  return n > 0 && n <= 65_536 && (n % 2048 === 0 || n % 1024 === 0)
}

export function isManthanPrefillStage(stage: string | null | undefined): boolean {
  if (!stage) return true
  return stage === "prompt_eval" || stage === "model_loading" || stage === "queue" || stage === "routing"
}

/**
 * llama /slots often reports the current n_batch chunk as both processed and
 * total (2048/2048 → 4096/4096). Drop the fake denominator until processed < total.
 * Compaction/generation payloads must not clobber prefill % or token counts.
 */
export function normalizeManthanPrefillProgress(
  next: ManthanPromptProgress,
  prev?: ManthanPromptProgress,
): ManthanPromptProgress {
  if (!isManthanPrefillStage(next.stage) && prev) {
    return {
      ...next,
      prompt_tokens: prev.prompt_tokens,
      prompt_tokens_processed: prev.prompt_tokens_processed,
      prompt_tokens_cached: prev.prompt_tokens_cached,
      percent: prev.percent,
      message: next.message ?? prev.message,
    }
  }

  let processed = next.prompt_tokens_processed
  let total = next.prompt_tokens
  let percent = next.percent

  if (typeof processed === "number" && typeof prev?.prompt_tokens_processed === "number") {
    processed = Math.max(processed, prev.prompt_tokens_processed)
  }

  const complete =
    typeof total === "number" && typeof processed === "number" && total > 0 && processed >= total
  const prevComplete =
    typeof prev?.prompt_tokens === "number" &&
    typeof prev.prompt_tokens_processed === "number" &&
    prev.prompt_tokens > 0 &&
    prev.prompt_tokens_processed >= prev.prompt_tokens
  const totalGrewComplete =
    complete && prevComplete && typeof prev?.prompt_tokens === "number" && total! > prev.prompt_tokens

  if (complete && (totalGrewComplete || isLikelyLlamaBatchSize(total!))) {
    processed = Math.max(processed ?? 0, total ?? 0)
    total = null
    percent = null
  } else if (typeof total === "number" && typeof processed === "number" && total > processed && total > 0) {
    percent = Math.max(0, Math.min(99, Math.round((100 * processed) / total)))
  } else if (typeof percent === "number") {
    percent = Math.max(0, Math.min(99, Math.round(percent)))
  }

  const message = next.message ?? prev?.message ?? null

  return {
    ...next,
    prompt_tokens: total,
    prompt_tokens_processed: processed,
    percent,
    message,
  }
}

export function rememberManthanPromptProgress(progress: ManthanPromptProgress): void {
  const normalized = normalizeManthanPrefillProgress(progress, promptProgressBySession.get(progress.sessionID))
  promptProgressBySession.set(progress.sessionID, normalized)
  for (const fn of promptProgressListeners) {
    try {
      fn(normalized)
    } catch {
      // ignore
    }
  }
  // Fan out to the desktop/web event stream (New Chat warmup listens).
  void import("@/bus/global")
    .then(({ GlobalBus }) => {
      GlobalBus.emit("event", {
        payload: {
          type: "manthan.prompt_progress",
          properties: normalized,
        },
      })
    })
    .catch(() => {})
}

export function peekManthanPromptProgress(sessionID: string): ManthanPromptProgress | undefined {
  return promptProgressBySession.get(sessionID)
}

export function subscribeManthanPromptProgress(fn: (p: ManthanPromptProgress) => void): () => void {
  promptProgressListeners.add(fn)
  return () => {
    promptProgressListeners.delete(fn)
  }
}

/** Clear prompt-progress store (tests). */
export function clearManthanPromptProgressStore(): void {
  promptProgressBySession.clear()
}

/** Parse complete `manthan-progress` SSE comment blocks from a text buffer. */
export function ingestManthanProgressSseComments(sessionID: string, text: string): string {
  if (!sessionID || !text) return text
  // Keep a trailing partial block; comments end with blank line.
  const parts = text.split(/\n\n/)
  const incomplete = text.endsWith("\n\n") ? "" : (parts.pop() ?? "")
  for (const block of parts) {
    const line = block
      .split("\n")
      .map((l) => l.trimEnd())
      .find((l) => l.startsWith(":") && l.includes("manthan-progress"))
    if (!line) continue
    const jsonStart = line.indexOf("{")
    if (jsonStart < 0) continue
    try {
      const payload = JSON.parse(line.slice(jsonStart)) as {
        object?: string
        stage?: string
        message?: string
        percent?: number
        prompt_tokens?: number
        prompt_tokens_processed?: number
        prompt_tokens_cached?: number
      }
      if (payload.object !== "manthan.progress") continue
      rememberManthanPromptProgress({
        sessionID,
        percent: typeof payload.percent === "number" ? payload.percent : null,
        prompt_tokens: typeof payload.prompt_tokens === "number" ? payload.prompt_tokens : null,
        prompt_tokens_processed:
          typeof payload.prompt_tokens_processed === "number" ? payload.prompt_tokens_processed : null,
        prompt_tokens_cached:
          typeof payload.prompt_tokens_cached === "number" ? payload.prompt_tokens_cached : null,
        stage: typeof payload.stage === "string" ? payload.stage : null,
        message: typeof payload.message === "string" ? payload.message : null,
        updated_at: Date.now(),
      })
    } catch {
      // ignore partial / bad JSON
    }
  }
  return incomplete
}

/** Tee an SSE Response so we can scrape prefill progress comments. */
export function teeManthanProgressResponse(res: Response, sessionID: string | undefined): Response {
  if (!sessionID || !res.body) return res
  const ct = res.headers.get("content-type") || ""
  if (!ct.includes("text/event-stream")) return res
  const [forClient, forProbe] = res.body.tee()
  void (async () => {
    const reader = forProbe.getReader()
    const decoder = new TextDecoder()
    let carry = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        carry += decoder.decode(value, { stream: true })
        carry = ingestManthanProgressSseComments(sessionID, carry)
      }
      carry += decoder.decode()
      ingestManthanProgressSseComments(sessionID, carry.endsWith("\n\n") ? carry : `${carry}\n\n`)
    } catch {
      // ignore — probe stream
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // ignore
      }
    }
  })()
  return new Response(forClient, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

/** `.../v1/chat/completions` → `.../v1/sessions/{id}/progress` */
export function manthanSessionProgressUrl(chatRequestUrl: string | URL, sessionID: string): string | undefined {
  if (!sessionID) return undefined
  try {
    const u = new URL(String(chatRequestUrl))
    const path = u.pathname.replace(/\/+$/, "")
    const v1 = path.lastIndexOf("/v1")
    u.pathname =
      v1 >= 0
        ? `${path.slice(0, v1 + 3)}/sessions/${encodeURIComponent(sessionID)}/progress`
        : `/v1/sessions/${encodeURIComponent(sessionID)}/progress`
    u.search = ""
    u.hash = ""
    return u.toString()
  } catch {
    return undefined
  }
}

function headerRecord(src: Headers | Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!src) return out
  const names = [
    "authorization",
    "x-api-key",
    "x-manthan-client",
    "x-opencode-session",
    "x-opencode-session-id",
    "x-session-affinity",
    "x-session-id",
  ]
  for (const name of names) {
    const v = headerGet(src, name)
    if (v) out[name] = v
  }
  return out
}

/** Poll Manthan `/v1/sessions/:id/progress` for live llama /slots prefill %. */
export function startManthanProgressPoll(opts: {
  sessionID: string
  url: string
  headers?: Headers | Record<string, string>
  signal?: AbortSignal
}): () => void {
  let stopped = false
  const ctrl = new AbortController()
  const onAbort = () => {
    stopped = true
    ctrl.abort()
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true })
  const headers = headerRecord(opts.headers)

  void (async () => {
    while (!stopped && !ctrl.signal.aborted) {
      try {
        const res = await fetch(opts.url, {
          headers,
          signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(2000)]),
        })
        if (res.ok) {
          const j = (await res.json()) as {
            percent?: number | null
            prompt_tokens?: number | null
            prompt_tokens_processed?: number | null
            prompt_tokens_cached?: number | null
            stage?: string | null
          }
          const percent = typeof j.percent === "number" ? j.percent : null
          const total = typeof j.prompt_tokens === "number" ? j.prompt_tokens : null
          const processed = typeof j.prompt_tokens_processed === "number" ? j.prompt_tokens_processed : null
          if (percent != null || (total != null && total > 0 && processed != null) || (processed != null && processed > 0)) {
            rememberManthanPromptProgress({
              sessionID: opts.sessionID,
              percent:
                percent ??
                (total && processed != null && total > processed
                  ? Math.max(0, Math.min(99, Math.round((100 * processed) / total)))
                  : null),
              prompt_tokens: total,
              prompt_tokens_processed: processed,
              prompt_tokens_cached: typeof j.prompt_tokens_cached === "number" ? j.prompt_tokens_cached : null,
              stage: typeof j.stage === "string" ? j.stage : null,
              message: null,
              updated_at: Date.now(),
            })
          }
        }
      } catch {
        // ignore transient poll errors
      }
      await Bun.sleep(400)
    }
  })()

  return () => {
    stopped = true
    ctrl.abort()
    opts.signal?.removeEventListener("abort", onAbort)
  }
}

const pendingCompact = new Set<string>()

/** Queue a one-shot `x-manthan-compact: 1` on the next model request. */
export function requestManthanCompact(sessionID: string): void {
  pendingCompact.add(sessionID)
}

/** Consume pending compact flag (returns true once). */
export function consumeManthanCompact(sessionID: string): boolean {
  if (!pendingCompact.has(sessionID)) return false
  pendingCompact.delete(sessionID)
  return true
}

export function clearManthanCompactQueue(): void {
  pendingCompact.clear()
}

export function manthanClientCompactAllowed(): boolean {
  return (
    process.env.OPENCODE_MANTHAN_ALLOW_CLIENT_COMPACT === "1" ||
    process.env.OPENCODE_MANTHAN_ALLOW_CLIENT_COMPACT === "true"
  )
}

/** Authoritative context usage from Manthan response headers (Phase 2). */
export type ManthanContextUsage = {
  context_limit: number | null
  context_used: number | null
  context_usable: number | null
  context_remaining: number | null
  context_usage_percent: number | null
  reserved_tokens: number | null
  compaction_threshold: number | null
  compaction_status: string | null
  cache_epoch: number | null
  cache_reuse_percent: number | null
  newly_evaluated_tokens: number | null
  cache_generation: number | null
  updated_at: number
}

const pendingBySession = new Map<string, ManthanContextUsage>()

function headerGet(headers: Headers | Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? (headers as Headers).get(name.toLowerCase()) ?? undefined
  }
  return headerLookup(headers as Record<string, string>, name)
}

function numHeader(headers: Headers | Record<string, string> | undefined, name: string): number | null {
  const raw = headerGet(headers, name)
  if (raw == null || raw === "") return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** True if any Manthan context header is present. */
export function hasManthanContextHeaders(headers: Headers | Record<string, string> | undefined): boolean {
  return (
    headerGet(headers, "x-manthan-context-used") != null ||
    headerGet(headers, "x-manthan-context-usage-percent") != null ||
    headerGet(headers, "x-manthan-context-limit") != null
  )
}

export function parseManthanContextHeaders(
  headers: Headers | Record<string, string> | undefined,
): ManthanContextUsage | null {
  if (!hasManthanContextHeaders(headers)) return null
  return {
    context_limit: numHeader(headers, "x-manthan-context-limit"),
    context_used: numHeader(headers, "x-manthan-context-used"),
    context_usable: numHeader(headers, "x-manthan-context-usable"),
    context_remaining: numHeader(headers, "x-manthan-context-remaining"),
    context_usage_percent: numHeader(headers, "x-manthan-context-usage-percent"),
    reserved_tokens: numHeader(headers, "x-manthan-reserved-tokens"),
    compaction_threshold: numHeader(headers, "x-manthan-compaction-threshold"),
    compaction_status: headerGet(headers, "x-manthan-compaction-status") ?? null,
    cache_epoch: numHeader(headers, "x-manthan-cache-epoch"),
    cache_reuse_percent: numHeader(headers, "x-manthan-cache-reuse-percent"),
    newly_evaluated_tokens: numHeader(headers, "x-manthan-newly-evaluated-tokens"),
    cache_generation: numHeader(headers, "x-manthan-cache-generation"),
    updated_at: Date.now(),
  }
}

export function sessionIDFromRequestHeaders(
  headers: Headers | Record<string, string> | undefined,
): string | undefined {
  return (
    headerGet(headers, "x-opencode-session-id") ||
    headerGet(headers, "x-opencode-session") ||
    headerGet(headers, "x-session-affinity") ||
    headerGet(headers, "x-session-id") ||
    undefined
  )
}

/** AI SDK often puts headers on the Request, not init — also check response echo. */
export function sessionIDFromFetch(input: {
  request?: Request | string | URL
  initHeaders?: Headers | Record<string, string>
  response?: Response | Headers | Record<string, string>
}): string | undefined {
  const resHeaders =
    input.response instanceof Response ? input.response.headers : input.response
  return (
    sessionIDFromRequestHeaders(input.initHeaders) ||
    (input.request instanceof Request ? sessionIDFromRequestHeaders(input.request.headers) : undefined) ||
    sessionIDFromRequestHeaders(resHeaders)
  )
}

/** Stash latest Manthan context for a session (fetch → processor handoff). */
export function rememberManthanContext(sessionID: string, usage: ManthanContextUsage): void {
  pendingBySession.set(sessionID, usage)
}

/** Read without clearing (TUI / debug). */
export function peekManthanContext(sessionID: string): ManthanContextUsage | undefined {
  return pendingBySession.get(sessionID)
}

/** Take pending context once for persistence onto session.metadata. */
export function takeManthanContext(sessionID: string): ManthanContextUsage | undefined {
  const v = pendingBySession.get(sessionID)
  if (v) pendingBySession.delete(sessionID)
  return v
}

/** Clear store (tests). */
export function clearManthanContextStore(): void {
  pendingBySession.clear()
}

export function formatManthanContextLabel(usage: ManthanContextUsage): string | undefined {
  const used = usage.context_used
  const limit = usage.context_limit
  const pct = usage.context_usage_percent
  const compactAt = usage.compaction_threshold
  if (used == null && pct == null && limit == null) return undefined
  const usedLabel = used != null ? Math.round(used).toLocaleString("en-US") : "?"
  const limitLabel = limit != null && limit > 0 ? Math.round(limit).toLocaleString("en-US") : null
  const parts: string[] = []
  if (limitLabel) parts.push(`${usedLabel} / ${limitLabel}`)
  else parts.push(usedLabel)
  if (pct != null) parts.push(`${Math.round(pct)}%`)
  if (compactAt != null && Number.isFinite(compactAt)) parts.push(`compact@${Math.round(compactAt)}%`)
  return parts.join(" · ")
}

export function manthanContextFromMetadata(metadata: Record<string, unknown> | undefined): ManthanContextUsage | null {
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
    reserved_tokens: typeof o.reserved_tokens === "number" ? o.reserved_tokens : null,
    compaction_threshold: typeof o.compaction_threshold === "number" ? o.compaction_threshold : null,
    compaction_status: typeof o.compaction_status === "string" ? o.compaction_status : null,
    cache_epoch: typeof o.cache_epoch === "number" ? o.cache_epoch : null,
    cache_reuse_percent: typeof o.cache_reuse_percent === "number" ? o.cache_reuse_percent : null,
    newly_evaluated_tokens: typeof o.newly_evaluated_tokens === "number" ? o.newly_evaluated_tokens : null,
    cache_generation: typeof o.cache_generation === "number" ? o.cache_generation : null,
    updated_at: typeof o.updated_at === "number" ? o.updated_at : 0,
  }
}
