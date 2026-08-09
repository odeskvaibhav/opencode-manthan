/**
 * Read Manthan Phase-2 context from session.metadata (written by opencode CLI).
 * Kept local to @opencode-ai/tui — no dependency on packages/opencode.
 */

export type ManthanContextUsage = {
  context_limit: number | null
  context_used: number | null
  context_usable: number | null
  context_remaining: number | null
  context_usage_percent: number | null
  compaction_status: string | null
  cache_epoch: number | null
  newly_evaluated_tokens: number | null
  cache_reuse_percent: number | null
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
    compaction_status: typeof o.compaction_status === "string" ? o.compaction_status : null,
    cache_epoch: typeof o.cache_epoch === "number" ? o.cache_epoch : null,
    newly_evaluated_tokens: typeof o.newly_evaluated_tokens === "number" ? o.newly_evaluated_tokens : null,
    cache_reuse_percent: typeof o.cache_reuse_percent === "number" ? o.cache_reuse_percent : null,
  }
}

export function formatManthanContextLabel(usage: ManthanContextUsage): string | undefined {
  const used = usage.context_used
  const pct = usage.context_usage_percent
  if (used == null && pct == null) return undefined
  const usedLabel = used != null ? Math.round(used).toLocaleString("en-US") : "?"
  if (pct != null) return `${usedLabel} (${Math.round(pct)}%)`
  return usedLabel
}
