/** SSE payload shape from OpenCode `/event`. */
export type OpencodeEvent = {
  type?: string
  properties?: Record<string, unknown>
}

export type EditReveal =
  | { kind: "create" }
  | { kind: "edit"; startLine: number; endLine: number } // 0-based inclusive; startLine < 0 ⇒ resolve via needles

const FILE_TOOLS = new Set(["edit", "write", "apply_patch", "ApplyPatch"])

/** First `+start` line from a unified diff hunk (0-based), or null. */
export function lineFromUnifiedDiff(diff: string): number | null {
  const m = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/m.exec(diff)
  if (!m) return null
  const oneBased = Number(m[1])
  if (!Number.isFinite(oneBased) || oneBased < 1) return null
  return oneBased - 1
}

/** Locate `needle` in `text`; returns 0-based inclusive line range. */
export function lineRangeFromNeedle(text: string, needle: string): { startLine: number; endLine: number } | null {
  if (!needle) return null
  const idx = text.indexOf(needle)
  if (idx < 0) return null
  const startLine = text.slice(0, idx).split("\n").length - 1
  const endLine = startLine + Math.max(0, needle.split("\n").length - 1)
  return { startLine, endLine }
}

export function refineEditReveal(
  docText: string,
  reveal: EditReveal,
  input?: { oldString?: string; newString?: string },
): EditReveal {
  if (reveal.kind === "create") return reveal
  if (reveal.startLine >= 0) return reveal
  if (input?.newString) {
    const hit = lineRangeFromNeedle(docText, input.newString)
    if (hit) return { kind: "edit", ...hit }
  }
  if (input?.oldString) {
    const hit = lineRangeFromNeedle(docText, input.oldString)
    if (hit) return { kind: "edit", ...hit }
  }
  return { kind: "edit", startLine: 0, endLine: 0 }
}

/** Line count of written content (for create highlights); undefined if unknown. */
export function createContentLineCount(content?: string): number | undefined {
  if (content == null || content === "") return undefined
  return content.split("\n").length
}

/**
 * 0-based inclusive lines to decorate for a reveal.
 * Creates: last N lines when content length known, else EOF line.
 */
export function highlightLinesFromReveal(
  reveal: EditReveal,
  lineCount: number,
  opts?: { createLineCount?: number },
): { startLine: number; endLine: number } {
  const last = Math.max(0, lineCount - 1)
  if (lineCount <= 0) return { startLine: 0, endLine: 0 }

  if (reveal.kind === "create") {
    const n = opts?.createLineCount
    if (n != null && n > 0) {
      return { startLine: Math.max(0, lineCount - n), endLine: last }
    }
    return { startLine: last, endLine: last }
  }

  let start = reveal.startLine
  let end = reveal.endLine
  if (start < 0 || end < 0) {
    start = 0
    end = 0
  }
  start = Math.max(0, Math.min(start, last))
  end = Math.max(start, Math.min(end, last))
  return { startLine: start, endLine: end }
}

type ToolPartLike = {
  tool?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    metadata?: Record<string, unknown>
  }
}

export function revealFromToolPart(
  part: ToolPartLike,
): {
  filePath: string
  reveal: EditReveal
  phase: "running" | "done"
  input: { oldString?: string; newString?: string }
  isCreate: boolean
} | null {
  if (!part.tool || !FILE_TOOLS.has(part.tool)) return null
  const state = part.state
  if (!state) return null
  const status = state.status
  if (status !== "pending" && status !== "running" && status !== "completed") return null

  const input = state.input ?? {}
  const meta = state.metadata ?? {}
  const filePath =
    (typeof input.filePath === "string" && input.filePath) ||
    (typeof meta.filepath === "string" && meta.filepath) ||
    (typeof meta.file === "string" && meta.file) ||
    ""
  if (!filePath) return null

  const phase: "running" | "done" = status === "completed" ? "done" : "running"
  const oldString = typeof input.oldString === "string" ? input.oldString : undefined
  const newString =
    typeof input.newString === "string"
      ? input.newString
      : typeof input.content === "string"
        ? input.content
        : undefined
  const needles = { oldString, newString }

  const isCreate =
    (part.tool === "write" && meta.exists === false) || (part.tool === "edit" && oldString === "")

  if (isCreate) {
    return { filePath, reveal: { kind: "create" }, phase, input: needles, isCreate: true }
  }

  const patch =
    typeof meta.diff === "string"
      ? meta.diff
      : meta.filediff && typeof meta.filediff === "object"
        ? String((meta.filediff as { patch?: string }).patch ?? "")
        : ""
  const fromDiff = patch ? lineFromUnifiedDiff(patch) : null
  if (fromDiff != null) {
    const span = newString ? Math.max(0, newString.split("\n").length - 1) : 0
    return {
      filePath,
      reveal: { kind: "edit", startLine: fromDiff, endLine: fromDiff + span },
      phase,
      input: needles,
      isCreate: false,
    }
  }

  return {
    filePath,
    reveal: { kind: "edit", startLine: -1, endLine: -1 },
    phase,
    input: needles,
    isCreate: false,
  }
}

export function parseSseChunk(buffer: string, onEvent: (ev: OpencodeEvent) => void): string {
  const parts = buffer.split("\n\n")
  const rest = parts.pop() ?? ""
  for (const block of parts) {
    const dataLines: string[] = []
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
    }
    if (dataLines.length === 0) continue
    try {
      onEvent(JSON.parse(dataLines.join("\n")) as OpencodeEvent)
    } catch {
      // ignore malformed SSE data
    }
  }
  return rest
}
