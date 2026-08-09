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
  const pct = usage.context_usage_percent
  if (used == null && pct == null) return undefined
  const usedLabel = used != null ? Math.round(used).toLocaleString("en-US") : "?"
  if (pct != null) return `${usedLabel} (${Math.round(pct)}%)`
  return usedLabel
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
