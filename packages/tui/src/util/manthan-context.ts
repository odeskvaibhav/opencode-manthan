/**
 * Read Manthan Phase-2 context from session.metadata (written by opencode CLI).
 * Kept local to @opencode-ai/tui — no dependency on packages/opencode.
 */

import { number as compactNumber } from "./locale"

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
  }
}

export function formatContextBar(input: {
  used: number | null
  limit: number | null
  percent: number | null
  compactAt?: number | null
}): string | undefined {
  const { used, limit, percent, compactAt } = input
  if (used == null && percent == null && limit == null) return undefined
  const usedLabel = used != null ? compactNumber(used) : "?"
  const limitLabel = limit != null && limit > 0 ? compactNumber(limit) : null
  let main = limitLabel ? `${usedLabel} / ${limitLabel}` : usedLabel
  if (percent != null) main += ` (${Math.round(percent)}%)`
  if (compactAt != null && Number.isFinite(compactAt)) return `${main} · compact@${Math.round(compactAt)}%`
  return main
}

export function formatManthanContextLabel(usage: ManthanContextUsage): string | undefined {
  return formatContextBar({
    used: usage.context_used,
    limit: usage.context_limit,
    percent: usage.context_usage_percent,
    compactAt: usage.compaction_threshold,
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
