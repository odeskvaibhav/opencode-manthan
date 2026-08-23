import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, PartID } from "@/session/schema"
import {
  MANTHAN_KEEP_RECENT_AFTER_COMPACT,
  MANTHAN_KEEP_RECENT_ON_OVERFLOW,
  selectManthanToolPartsToCompact,
} from "@/session/manthan-prune"

function toolPart(id: string, output: string, compacted?: number): SessionV1.ToolPart {
  return {
    id: `prt_${id}` as PartID,
    messageID: "msg_a1" as MessageID,
    sessionID: "ses_test" as SessionV1.WithParts["info"]["sessionID"],
    type: "tool",
    callID: id,
    tool: "read",
    state: {
      status: "completed",
      input: { path: id },
      output,
      title: "read",
      metadata: {},
      time: { start: 0, end: 1, ...(compacted ? { compacted } : {}) },
    },
  }
}

function assistant(id: string, parts: SessionV1.Part[]): SessionV1.WithParts {
  return {
    info: {
      id: `msg_${id}` as MessageID,
      role: "assistant",
      sessionID: "ses_test" as SessionV1.WithParts["info"]["sessionID"],
      mode: "build",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "m",
      providerID: "manthan",
      parentID: "msg_u1" as MessageID,
      time: { created: 0 },
      finish: "stop",
    },
    parts,
  }
}

describe("selectManthanToolPartsToCompact", () => {
  test("post_compact clears all tools before compact message and keeps recent tail", () => {
    const msgs: SessionV1.WithParts[] = [
      assistant("a1", [toolPart("t1", "old1"), toolPart("t2", "old2")]),
      assistant("a2", [
        toolPart("t3", "mid1"),
        toolPart("t4", "mid2"),
        toolPart("t5", "mid3"),
        toolPart("t6", "mid4"),
        toolPart("t7", "recent1"),
        toolPart("t8", "recent2"),
      ]),
    ]
    const selected = selectManthanToolPartsToCompact(msgs, {
      mode: "post_compact",
      compactMessageID: "msg_a2",
    })
    const ids = selected.map((p) => p.callID).sort()
    // a1 tools + older half of a2 (keep last 4 on compact turn)
    expect(ids).toEqual(["t1", "t2", "t3", "t4"])
  })

  test("post_compact keeps only last N tool results after compact point", () => {
    const parts = Array.from({ length: 8 }, (_, i) => toolPart(`t${i}`, `body${i}`))
    const msgs = [assistant("a2", parts)]
    const selected = selectManthanToolPartsToCompact(msgs, {
      mode: "post_compact",
      compactMessageID: "msg_a2",
    })
    expect(selected).toHaveLength(8 - MANTHAN_KEEP_RECENT_AFTER_COMPACT)
    expect(selected.map((p) => p.callID).sort()).toEqual(["t0", "t1", "t2", "t3"])
  })

  test("overflow keeps at most one recent tool output globally", () => {
    const msgs: SessionV1.WithParts[] = [
      assistant("a1", [toolPart("t1", "a"), toolPart("t2", "b")]),
      assistant("a2", [toolPart("t3", "c"), toolPart("t4", "d")]),
    ]
    const selected = selectManthanToolPartsToCompact(msgs, { mode: "overflow" })
    expect(selected).toHaveLength(3)
    expect(selected.map((p) => p.callID).sort()).toEqual(["t1", "t2", "t3"])
  })

  test("skips already compacted and protected tools", () => {
    const skill = toolPart("skill", "secret")
    skill.tool = "skill"
    const msgs = [
      assistant("a1", [toolPart("t1", "x", Date.now()), skill, toolPart("t2", "y")]),
    ]
    const selected = selectManthanToolPartsToCompact(msgs, { mode: "overflow" })
    // t2 is the only recent tool kept; t1 already compacted; skill protected
    expect(selected).toHaveLength(0)
  })
})
