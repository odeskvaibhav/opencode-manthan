/** OpenCode New Chat warmup + generic “what can you do” greets. */

export const MANTHAN_WARMUP_LINE = "Hi, what can you do for me?"

export function isWarmupOrCapabilityAsk(content: string | undefined): boolean {
  const t = (content || "").replace(/\s+/g, " ").trim()
  if (!t) return false
  if (t === MANTHAN_WARMUP_LINE) return true
  if (/^hi[,.]?\s*what can you do/i.test(t)) return true
  if (/^what can you (do|help|assist)\b/i.test(t)) return true
  if (
    t.length < 160 &&
    /what (can|do) you (do|help|assist)/i.test(t) &&
    !/\b(file|code|repo|bug|test|kanban|implement|fix)\b/i.test(t)
  ) {
    return true
  }
  return false
}

/** Non-synthetic user text from message parts (warmup detection). */
export function userAskText(parts: ReadonlyArray<{ type: string; text?: string; synthetic?: boolean }>): string {
  return parts
    .filter((p): p is { type: "text"; text: string; synthetic?: boolean } => p.type === "text" && !p.synthetic)
    .map((p) => p.text)
    .join("\n")
}
