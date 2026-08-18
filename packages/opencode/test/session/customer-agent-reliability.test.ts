/**
 * Customer-facing coding-agent reliability journeys.
 * Pure/orchestrator contracts — no live servers required.
 */
import { describe, expect, test, beforeEach } from "bun:test"
import { SessionID } from "../../src/session/schema"
import { formatTaskToolOutput } from "../../src/tool/task"
import {
  TOOL_LOOP_PIVOT_THRESHOLD,
  ToolLoopAbortError,
  buildToolLoopPivotSteerText,
  evaluateToolLoop,
  peekToolLoopPivot,
  requestToolLoopPivot,
  resetToolLoopSessionState,
  takeToolLoopPivot,
  toolLoopKey,
} from "../../src/session/loop-detection"

const SID = "customer-sess"

function emptyBash(command: string) {
  return {
    tool: "bash",
    input: { command },
    output: "",
    status: "completed" as const,
  }
}

describe("customer journeys — tool loop → pivot → ban", () => {
  beforeEach(() => resetToolLoopSessionState(SID))

  test("journey: doom-loop find → refuse → keep going → pivot → ban relapse", () => {
    const cmds = [
      "find . -name mapping-data.ts",
      'find . -name "*mapping*" -type f',
      'find . -name "*mapping-data*" -type f',
      'find . -path "*/src/*" -name "*mapping*" -type f',
      'find . -name mapping-data.ts -type f',
    ]

    // Turn 2: refuse empty-success rematch — customer still sees the agent working
    const refuse = evaluateToolLoop(
      [emptyBash(cmds[0]!)],
      { tool: "bash", input: { command: cmds[1]! } },
      { sessionID: SID },
    )
    expect(refuse.refuse).toBe(true)
    expect(refuse.pivot).toBe(false)
    expect(refuse.reason).toBe("empty_success")
    const refuseErr = new ToolLoopAbortError("bash", refuse.count, {
      fatal: false,
      key: toolLoopKey("bash", { command: cmds[2]! }),
    })
    expect(refuseErr.message).toMatch(/Pivot:/i)
    expect(ToolLoopAbortError.isFatal(refuseErr)).toBe(false)

    // Turn 5: pivot — customer gets text-only recovery, not a dead session
    const hist4 = cmds.slice(0, 4).map((c) => emptyBash(c))
    const pivot = evaluateToolLoop(hist4, { tool: "bash", input: { command: cmds[4]! } }, { sessionID: SID })
    expect(pivot.refuse).toBe(true)
    expect(pivot.pivot).toBe(true)
    expect(pivot.count).toBe(TOOL_LOOP_PIVOT_THRESHOLD)

    const key = toolLoopKey("bash", { command: cmds[4]! })
    const fatal = new ToolLoopAbortError("bash", pivot.count, { fatal: true, key })
    requestToolLoopPivot(SID, { tool: "bash", count: pivot.count, key })
    expect(peekToolLoopPivot(SID)).toBeTruthy()

    const steer = buildToolLoopPivotSteerText(peekToolLoopPivot(SID)!)
    expect(steer).toContain("[tool_loop_pivot]")
    expect(steer).toMatch(/no tools/i)
    expect(steer).toMatch(/Pivot now/i)
    expect(fatal.message).toContain("text-only pivot")

    // Prompt consumes pivot → text-only turn
    takeToolLoopPivot(SID)
    expect(peekToolLoopPivot(SID)).toBeUndefined()

    // Relapse after pivot: still refused (banned) — customer doesn't re-enter the same spin
    const relapse = evaluateToolLoop(
      [emptyBash(cmds[4]!)],
      { tool: "glob", input: { pattern: "**/*mapping-data*" } },
      { sessionID: SID },
    )
    expect(relapse.refuse).toBe(true)
    expect(relapse.reason).toBe("banned")
  })

  test("journey: parent sees structured subagent failure, not a blank hang", () => {
    const out = formatTaskToolOutput({
      sessionID: SessionID.make("ses_child_1"),
      state: "error",
      summary: "Background task failed: explore mapping",
      text: "Tool loop refused: bash repeated 5 times with no progress.",
    })
    expect(out).toContain('state="error"')
    expect(out).toContain("<task_error>")
    expect(out).toContain("Tool loop refused")
    expect(out).toContain("<summary>Background task failed:")
    // completed path must not use task_error
    const ok = formatTaskToolOutput({
      sessionID: SessionID.make("ses_child_2"),
      state: "completed",
      summary: "done",
      text: "found it",
    })
    expect(ok).toContain("<task_result>")
    expect(ok).not.toContain("<task_error>")
  })
})
