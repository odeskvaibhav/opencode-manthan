import { describe, expect, test, beforeEach } from "bun:test"
import {
  TOOL_LOOP_REFUSE_THRESHOLD,
  TOOL_LOOP_PIVOT_THRESHOLD,
  ToolLoopAbortError,
  buildToolLoopPivotSteerText,
  clearToolLoopPivot,
  countNoProgressStreak,
  evaluateToolLoop,
  peekToolLoopPivot,
  requestToolLoopPivot,
  resetToolLoopSessionState,
  takeToolLoopPivot,
  toolInvocationsFromMessages,
  toolLoopKey,
  toolLoopKeysRelated,
} from "../../src/session/loop-detection"

describe("tool loop detection", () => {
  beforeEach(() => resetToolLoopSessionState("s1"))

  test("collapses near-identical find commands onto related keys", () => {
    const a = toolLoopKey("bash", { command: "find . -name mapping-data.ts" })
    const b = toolLoopKey("bash", { command: 'find . -name "*mapping*" -type f' })
    const c = toolLoopKey("bash", { command: 'find . -name "*mapping-data*" -type f' })
    expect(toolLoopKeysRelated(a, b)).toBe(true)
    expect(toolLoopKeysRelated(a, c)).toBe(true)
  })

  test("refuses on third no-progress find but does not pivot yet", () => {
    const history = [
      {
        tool: "bash",
        input: { command: "find . -name mapping-data.ts" },
        output: "",
        status: "completed" as const,
      },
      {
        tool: "bash",
        input: { command: 'find . -name "*mapping*" -type f' },
        output: "",
        status: "completed" as const,
      },
    ]
    const next = { tool: "bash", input: { command: 'find . -name "*mapping-data*" -type f' } }
    expect(countNoProgressStreak(history, next)).toBe(3)
    const decision = evaluateToolLoop(history, next)
    expect(decision.refuse).toBe(true)
    expect(decision.pivot).toBe(false)
    expect(decision.count).toBe(TOOL_LOOP_REFUSE_THRESHOLD)
  })

  test("pivots at hard threshold (not a user-facing halt)", () => {
    const args = { command: "rm -rf /tmp/x" }
    const history = Array.from({ length: TOOL_LOOP_PIVOT_THRESHOLD - 1 }, () => ({
      tool: "bash",
      input: args,
      output: "",
      status: "completed" as const,
    }))
    const decision = evaluateToolLoop(history, { tool: "bash", input: args })
    expect(decision.refuse).toBe(true)
    expect(decision.pivot).toBe(true)
    expect(decision.count).toBe(TOOL_LOOP_PIVOT_THRESHOLD)
  })

  test("does not refuse when successful outputs change (progress)", () => {
    const history = [
      {
        tool: "bash",
        input: { command: "npm test" },
        output: "failing 1",
        status: "completed" as const,
      },
      {
        tool: "bash",
        input: { command: "npm test" },
        output: "failing 0 — all passed",
        status: "completed" as const,
      },
    ]
    const next = { tool: "bash", input: { command: "npm test" } }
    expect(evaluateToolLoop(history, next).refuse).toBe(false)
  })

  test("toolInvocationsFromMessages skips pending", () => {
    const inv = toolInvocationsFromMessages([
      {
        parts: [
          { type: "tool", tool: "bash", state: { status: "pending", input: {} } },
          {
            type: "tool",
            tool: "bash",
            state: { status: "completed", input: { command: "ls" }, output: "a" },
          },
        ],
      },
    ])
    expect(inv).toHaveLength(1)
    expect(inv[0]!.output).toBe("a")
  })

  test("ToolLoopAbortError fatal vs refuse", () => {
    clearToolLoopPivot("s1")
    const refuse = new ToolLoopAbortError("bash", 3)
    const pivot = new ToolLoopAbortError("bash", 5, { fatal: true })
    expect(ToolLoopAbortError.is(refuse)).toBe(true)
    expect(ToolLoopAbortError.isFatal(refuse)).toBe(false)
    expect(ToolLoopAbortError.isFatal(pivot)).toBe(true)
    requestToolLoopPivot("s1", { tool: "bash", count: 5 })
    expect(peekToolLoopPivot("s1")?.tool).toBe("bash")
    const text = buildToolLoopPivotSteerText(takeToolLoopPivot("s1")!)
    expect(text).toContain("[tool_loop_pivot]")
    expect(text).toContain("no tools")
    expect(peekToolLoopPivot("s1")).toBeUndefined()
  })
})
