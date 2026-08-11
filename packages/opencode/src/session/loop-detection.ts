/**
 * Tool-loop guard (orchestrator safety).
 *
 * Industry pattern (Cline refuse + DeerFlow forced reply):
 * - Refuse threshold: do not execute; return a real tool error that tells the
 *   model to pivot. Session keeps running with tools.
 * - Pivot threshold: refuse again, then force one text-only turn (no tools) so
 *   the model must answer / change strategy — never dump recovery on the user.
 * - Also: cross-tool search family, A↔B oscillation, post-pivot signature ban,
 *   hard cap even when outputs change (fake progress).
 *
 * Soft ephemeral prompt-hint injection is not used.
 */

/** First refuse (Cline soft). Tool error in history; agent may continue. */
export const TOOL_LOOP_REFUSE_THRESHOLD = 3
/** Force a text-only pivot turn (no tools). */
export const TOOL_LOOP_PIVOT_THRESHOLD = 5
/** A↔B↔A↔B with no progress — refuse at this many calls (incl. next). */
export const TOOL_LOOP_OSCILLATION_REFUSE = 4
/** Same key this many times even if output changes → refuse (fake progress). */
export const TOOL_LOOP_FAKE_PROGRESS_CAP = 8

/** @deprecated use TOOL_LOOP_REFUSE_THRESHOLD */
export const TOOL_LOOP_HARD_THRESHOLD = TOOL_LOOP_REFUSE_THRESHOLD
/** @deprecated use TOOL_LOOP_PIVOT_THRESHOLD */
export const TOOL_LOOP_STOP_THRESHOLD = TOOL_LOOP_PIVOT_THRESHOLD

export type ToolInvocation = {
  tool: string
  input: unknown
  /** Completed stdout/content; omit for error/running. */
  output?: string
  status: "completed" | "error" | "running" | "pending"
}

export type ToolLoopDecision = {
  /** Do not execute — return ToolLoopAbortError as the tool result. */
  refuse: boolean
  /** After this refuse, force a text-only pivot turn. */
  pivot: boolean
  count: number
  reason?: "streak" | "oscillation" | "fake_progress" | "banned"
}

export type ToolLoopPivotRequest = {
  tool: string
  count: number
  key?: string
}

const pendingPivotBySession = new Map<string, ToolLoopPivotRequest>()
/** After a pivot, these keys (and related) stay refused for the session run. */
const bannedKeysBySession = new Map<string, Set<string>>()

export function requestToolLoopPivot(sessionID: string, info: ToolLoopPivotRequest): void {
  pendingPivotBySession.set(sessionID, info)
  if (info.key) banToolLoopKey(sessionID, info.key)
}

export function peekToolLoopPivot(sessionID: string): ToolLoopPivotRequest | undefined {
  return pendingPivotBySession.get(sessionID)
}

/** Consume the pending pivot (next turn runs text-only). */
export function takeToolLoopPivot(sessionID: string): ToolLoopPivotRequest | undefined {
  const info = pendingPivotBySession.get(sessionID)
  pendingPivotBySession.delete(sessionID)
  return info
}

export function clearToolLoopPivot(sessionID: string): void {
  pendingPivotBySession.delete(sessionID)
}

export function banToolLoopKey(sessionID: string, key: string): void {
  let set = bannedKeysBySession.get(sessionID)
  if (!set) {
    set = new Set()
    bannedKeysBySession.set(sessionID, set)
  }
  set.add(key)
}

export function clearToolLoopBans(sessionID: string): void {
  bannedKeysBySession.delete(sessionID)
}

export function resetToolLoopSessionState(sessionID: string): void {
  clearToolLoopPivot(sessionID)
  clearToolLoopBans(sessionID)
}

function isBannedKey(sessionID: string | undefined, key: string): boolean {
  if (!sessionID) return false
  const set = bannedKeysBySession.get(sessionID)
  if (!set) return false
  for (const banned of set) {
    if (toolLoopKeysRelated(banned, key)) return true
  }
  return false
}

export function buildToolLoopPivotSteerText(info: ToolLoopPivotRequest): string {
  return [
    `[tool_loop_pivot] Tool "${info.tool}" was refused after ${info.count} no-progress repeats.`,
    "Do not call that tool (or near-identical variants) again.",
    "Pivot now: use a different approach, or answer with what you already know from earlier tool results.",
    "This turn has no tools — reply in text only.",
  ].join(" ")
}

export class ToolLoopAbortError extends Error {
  readonly _tag = "ToolLoopAbortError" as const
  readonly tool: string
  readonly count: number
  readonly key: string
  /** When true, orchestrator queues a forced text-only pivot turn. */
  readonly fatal: boolean

  constructor(tool: string, count: number, opts?: { fatal?: boolean; key?: string }) {
    const fatal = opts?.fatal === true
    super(
      fatal
        ? `Tool loop refused: "${tool}" repeated ${count} times with no progress. ` +
            `That call was not executed. A text-only pivot turn follows — answer or change strategy; do not retry the same tool.`
        : `Tool loop refused: "${tool}" repeated ${count} times with no progress. ` +
            `That call was not executed. Pivot: use a different tool (glob/read/grep) or answer with what you already know — do not retry the same search.`,
    )
    this.name = "ToolLoopAbortError"
    this.tool = tool
    this.count = count
    this.key = opts?.key ?? toolLoopKey(tool, {})
    this.fatal = fatal
  }

  static is(error: unknown): boolean {
    if (error instanceof ToolLoopAbortError) return true
    if (
      error &&
      typeof error === "object" &&
      "_tag" in error &&
      (error as { _tag: string })._tag === "ToolLoopAbortError"
    ) {
      return true
    }
    const msg = errorMessage(error)
    return msg.includes("Tool loop refused:") || msg.includes("Tool loop stopped:") || msg.includes("Tool loop aborted:")
  }

  static isFatal(error: unknown): boolean {
    if (error instanceof ToolLoopAbortError) return error.fatal
    const msg = errorMessage(error)
    return msg.includes("text-only pivot") || msg.includes("Session halted")
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message)
  return ""
}

function extractSearchStem(text: string): string {
  const needles = [
    ...text.matchAll(/-(?:name|iname|path|ipath|wholename)\s+["']?([^\s"']+)/gi),
  ].map((m) =>
    m[1]!
      .toLowerCase()
      .replace(/^\*+|\*+$/g, "")
      .replace(/\.[a-z0-9]+$/i, ""),
  )
  const fromGlob = text
    .toLowerCase()
    .replace(/^\*+|\*+$/g, "")
    .replace(/\.[a-z0-9]+$/i, "")
  const primary =
    needles.filter((n) => n.length >= 3).sort((a, b) => b.length - a.length)[0] ??
    (fromGlob.length >= 3 ? fromGlob.replace(/[^a-z0-9_-]+/g, "").slice(0, 24) : "any")
  return primary.slice(0, Math.min(12, primary.length)) || "any"
}

/** Collapse near-duplicate calls; unify find/glob/grep on the same needle. */
export function toolLoopKey(tool: string, input: unknown): string {
  const name = tool.toLowerCase()
  const record = isRecord(input) ? input : { value: input }
  const argsJson = stableStringify(record)
  const cmd = String(record.command ?? record.cmd ?? record.script ?? "")
    .replace(/\s+/g, " ")
    .trim()

  if ((name === "bash" || name === "shell" || name === "run_terminal_cmd") && cmd) {
    if (/\bfind\b/.test(cmd)) {
      return `search\0${extractSearchStem(cmd)}`
    }
    return `${name}\0${cmd}`
  }

  if (name === "glob" || name === "grep" || name === "search") {
    const pat = String(record.pattern ?? record.glob ?? record.path ?? record.query ?? argsJson)
      .replace(/\s+/g, " ")
      .trim()
    return `search\0${extractSearchStem(pat)}`
  }

  if (name === "read" || name === "read_file") {
    const path = String(record.path ?? record.file_path ?? record.filePath ?? argsJson)
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
    return `read\0${path}`
  }

  return `${name}\0${argsJson}`
}

export function toolLoopKeysRelated(a: string, b: string): boolean {
  if (a === b) return true
  const as = a.match(/^search\0(.+)$/)
  const bs = b.match(/^search\0(.+)$/)
  if (as && bs) {
    const x = as[1]!
    const y = bs[1]!
    if (x === "any" || y === "any") return true
    return x.startsWith(y) || y.startsWith(x) || x.includes(y) || y.includes(x)
  }
  // Legacy bash\0find: stem keys
  const af = a.match(/^(?:bash|shell|run_terminal_cmd)\0find:(.+)$/)
  const bf = b.match(/^(?:bash|shell|run_terminal_cmd)\0find:(.+)$/)
  if (af && bf) {
    const x = af[1]!
    const y = bf[1]!
    if (x === "any" || y === "any") return true
    return x.startsWith(y) || y.startsWith(x) || x.includes(y) || y.includes(x)
  }
  return false
}

export function outputFingerprint(inv: Pick<ToolInvocation, "output" | "status">): string {
  if (inv.status !== "completed") return `status:${inv.status}`
  const t = (inv.output ?? "").replace(/\s+/g, " ").trim().slice(0, 500)
  return t || "(empty)"
}

/**
 * How many consecutive no-progress related calls would this next call be
 * (including itself)?
 */
export function countNoProgressStreak(
  history: readonly ToolInvocation[],
  next: { tool: string; input: unknown },
): number {
  const nextKey = toolLoopKey(next.tool, next.input)
  let streak = 0
  let newerFp: string | undefined

  for (let i = history.length - 1; i >= 0; i--) {
    const inv = history[i]!
    const key = toolLoopKey(inv.tool, inv.input)
    if (!toolLoopKeysRelated(nextKey, key)) break

    const fp = outputFingerprint(inv)
    if (
      newerFp !== undefined &&
      inv.status === "completed" &&
      newerFp !== fp &&
      fp !== "(empty)" &&
      newerFp !== "(empty)" &&
      !newerFp.startsWith("status:") &&
      !fp.startsWith("status:")
    ) {
      break
    }

    streak++
    newerFp = fp
  }

  return streak + 1
}

/** Same-key count ignoring output progress (fake-progress / flake guard). */
export function countSameKeyStreak(
  history: readonly ToolInvocation[],
  next: { tool: string; input: unknown },
): number {
  const nextKey = toolLoopKey(next.tool, next.input)
  let streak = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const key = toolLoopKey(history[i]!.tool, history[i]!.input)
    if (!toolLoopKeysRelated(nextKey, key)) break
    streak++
  }
  return streak + 1
}

/**
 * Detect A↔B oscillation with no progress over the recent tail.
 * Returns streak length including `next` when oscillating; else 0.
 */
export function countOscillationStreak(
  history: readonly ToolInvocation[],
  next: { tool: string; input: unknown },
): number {
  const nextKey = toolLoopKey(next.tool, next.input)
  const keys: string[] = [nextKey]
  const fps: string[] = ["(pending)"]

  for (let i = history.length - 1; i >= 0 && keys.length < 8; i--) {
    const inv = history[i]!
    keys.push(toolLoopKey(inv.tool, inv.input))
    fps.push(outputFingerprint(inv))
  }

  if (keys.length < TOOL_LOOP_OSCILLATION_REFUSE) return 0

  // keys[0]=next (newest). Need alternating between exactly two unrelated keys.
  const a = keys[0]!
  const b = keys[1]!
  if (toolLoopKeysRelated(a, b)) return 0

  let alternating = true
  for (let i = 0; i < keys.length; i++) {
    const expect = i % 2 === 0 ? a : b
    if (!toolLoopKeysRelated(keys[i]!, expect)) {
      alternating = false
      break
    }
  }
  if (!alternating) return 0

  // No progress: every completed fingerprint in the oscillated history is empty/error/same.
  const completed = fps.slice(1).filter((fp) => !fp.startsWith("status:") || fp === "status:error")
  const meaningful = completed.filter((fp) => fp !== "(empty)" && fp !== "status:error")
  const uniqueMeaningful = new Set(meaningful)
  if (uniqueMeaningful.size > 1) return 0

  return keys.length
}

export function evaluateToolLoop(
  history: readonly ToolInvocation[],
  next: { tool: string; input: unknown },
  opts?: { refuseAt?: number; pivotAt?: number; sessionID?: string },
): ToolLoopDecision {
  const refuseAt = opts?.refuseAt ?? TOOL_LOOP_REFUSE_THRESHOLD
  const pivotAt = opts?.pivotAt ?? TOOL_LOOP_PIVOT_THRESHOLD
  const nextKey = toolLoopKey(next.tool, next.input)
  const sessionID = opts?.sessionID

  if (sessionID && isBannedKey(sessionID, nextKey)) {
    return { refuse: true, pivot: !peekToolLoopPivot(sessionID), count: 99, reason: "banned" }
  }

  const streak = countNoProgressStreak(history, next)
  const sameKey = countSameKeyStreak(history, next)
  const osc = countOscillationStreak(history, next)

  let count = streak
  let reason: ToolLoopDecision["reason"] = "streak"

  if (osc >= TOOL_LOOP_OSCILLATION_REFUSE && osc >= count) {
    count = osc
    reason = "oscillation"
  }
  if (sameKey >= TOOL_LOOP_FAKE_PROGRESS_CAP && sameKey >= count) {
    count = sameKey
    reason = "fake_progress"
  }

  const refuse =
    streak >= refuseAt ||
    osc >= TOOL_LOOP_OSCILLATION_REFUSE ||
    sameKey >= TOOL_LOOP_FAKE_PROGRESS_CAP
  const pivot =
    streak >= pivotAt ||
    osc >= TOOL_LOOP_PIVOT_THRESHOLD ||
    sameKey >= TOOL_LOOP_FAKE_PROGRESS_CAP

  return { refuse, pivot, count, reason: refuse ? reason : undefined }
}

/** @deprecated prefer evaluateToolLoop — `abort` means refuse (not necessarily pivot). */
export function shouldAbortToolLoop(
  history: readonly ToolInvocation[],
  next: { tool: string; input: unknown },
  threshold = TOOL_LOOP_REFUSE_THRESHOLD,
): { abort: boolean; count: number } {
  const decision = evaluateToolLoop(history, next, { refuseAt: threshold, pivotAt: Number.POSITIVE_INFINITY })
  return { abort: decision.refuse, count: decision.count }
}

/** Extract completed/errored tool parts from session messages (chronological). */
export function toolInvocationsFromMessages(
  messages: ReadonlyArray<{ parts?: ReadonlyArray<unknown> }>,
): ToolInvocation[] {
  const out: ToolInvocation[] = []
  for (const msg of messages) {
    for (const part of msg.parts ?? []) {
      if (!isRecord(part) || part.type !== "tool") continue
      const tool = typeof part.tool === "string" ? part.tool : ""
      if (!tool) continue
      const state = isRecord(part.state) ? part.state : null
      if (!state || typeof state.status !== "string") continue
      if (state.status === "pending") continue
      const status = state.status as ToolInvocation["status"]
      out.push({
        tool,
        input: state.input ?? {},
        output: status === "completed" && typeof state.output === "string" ? state.output : undefined,
        status,
      })
    }
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`
}
