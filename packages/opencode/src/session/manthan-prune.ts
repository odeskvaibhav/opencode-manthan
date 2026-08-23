/**
 * Manthan Option A: server compacts for inference, but OpenCode still stores full
 * tool outputs locally. Without pruning, the next HTTP POST exceeds body limits
 * (413) before the API can compact again.
 *
 * After server compact (or on overflow), mark old tool outputs as compacted so
 * message-v2 replays them as "[Old tool result content cleared]".
 */
import { Effect } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session, type Interface as SessionInterface } from "./session"
import type { SessionID } from "./schema"
import { NotFoundError } from "@/storage/storage"

const PRUNE_PROTECTED_TOOLS = new Set(["skill"])

/** Recent tool results to keep after a successful server compact. */
export const MANTHAN_KEEP_RECENT_AFTER_COMPACT = 4

/** On 413 / overflow, keep at most one completed tool output. */
export const MANTHAN_KEEP_RECENT_ON_OVERFLOW = 1

export type ManthanPruneMode = "post_compact" | "overflow"

export type ManthanPruneOpts = {
  mode: ManthanPruneMode
  /** Assistant turn that received manthan compact telemetry — prune all tools before it. */
  compactMessageID?: string | null
}

function keepRecentCount(mode: ManthanPruneMode): number {
  return mode === "overflow" ? MANTHAN_KEEP_RECENT_ON_OVERFLOW : MANTHAN_KEEP_RECENT_AFTER_COMPACT
}

function isCompletedToolPart(
  part: SessionV1.Part,
): part is SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted } {
  return part.type === "tool" && part.state.status === "completed"
}

/** Pure selector — unit-tested. */
export function selectManthanToolPartsToCompact(
  msgs: SessionV1.WithParts[],
  opts: ManthanPruneOpts,
): SessionV1.ToolPart[] {
  const keepRecent = keepRecentCount(opts.mode)
  let compactBeforeIndex = -1
  if (opts.compactMessageID) {
    compactBeforeIndex = msgs.findIndex((m) => m.info.id === opts.compactMessageID)
  }

  const toCompact: SessionV1.ToolPart[] = []
  let recentKept = 0

  for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
    const msg = msgs[msgIndex]!
    const beforeCompact = compactBeforeIndex >= 0 && msgIndex < compactBeforeIndex

    for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = msg.parts[partIndex]!
      if (!isCompletedToolPart(part)) continue
      if (PRUNE_PROTECTED_TOOLS.has(part.tool)) continue
      if (part.state.time.compacted) continue

      if (beforeCompact) {
        toCompact.push(part)
        continue
      }

      if (recentKept < keepRecent) {
        recentKept++
        continue
      }
      toCompact.push(part)
    }
  }

  return toCompact
}

export function pruneManthanLocalToolOutputs(
  session: SessionInterface,
  input: {
    sessionID: SessionID
  } & ManthanPruneOpts,
): Effect.Effect<number> {
  return Effect.gen(function* () {
    const msgs = yield* session
      .messages({ sessionID: input.sessionID })
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
    if (!msgs?.length) return 0

    const parts = selectManthanToolPartsToCompact(msgs, input)
    if (!parts.length) return 0

    const now = Date.now()
    for (const part of parts) {
      part.state.time.compacted = now
      yield* session.updatePart(part)
    }

    yield* Effect.logInfo("manthan local tool prune", {
      sessionID: input.sessionID,
      mode: input.mode,
      count: parts.length,
      compactMessageID: input.compactMessageID ?? null,
    })
    return parts.length
  })
}
