import { describe, expect, test, beforeEach } from "bun:test"
import {
  TOOL_LOOP_FAKE_PROGRESS_CAP,
  TOOL_LOOP_OSCILLATION_REFUSE,
  TOOL_LOOP_PIVOT_THRESHOLD,
  TOOL_LOOP_REFUSE_THRESHOLD,
  ToolLoopAbortError,
  banToolLoopKey,
  buildToolLoopPivotSteerText,
  countNoProgressStreak,
  countOscillationStreak,
  evaluateToolLoop,
  peekToolLoopPivot,
  requestToolLoopPivot,
  resetToolLoopSessionState,
  takeToolLoopPivot,
  toolInvocationsFromMessages,
  toolLoopKey,
  toolLoopKeysRelated,
} from "../../src/session/loop-detection"

const empty = (tool: string, input: unknown) => ({
  tool,
  input,
  output: "",
  status: "completed" as const,
})

const ok = (tool: string, input: unknown, output: string) => ({
  tool,
  input,
  output,
  status: "completed" as const,
})

const err = (tool: string, input: unknown) => ({
  tool,
  input,
  status: "error" as const,
})

describe("tool loop scenarios", () => {
  beforeEach(() => {
    resetToolLoopSessionState("sess")
    resetToolLoopSessionState("s1")
  })

  test("scenario: exact identical empty bash succeeds → refuse@3 pivot@5", () => {
    const args = { command: "rm -rf /tmp/x" }
    const h2 = [empty("bash", args), empty("bash", args)]
    const r3 = evaluateToolLoop(h2, { tool: "bash", input: args })
    expect(r3.refuse).toBe(true)
    expect(r3.pivot).toBe(false)
    expect(r3.count).toBe(TOOL_LOOP_REFUSE_THRESHOLD)

    const h4 = Array.from({ length: 4 }, () => empty("bash", args))
    const r5 = evaluateToolLoop(h4, { tool: "bash", input: args })
    expect(r5.refuse).toBe(true)
    expect(r5.pivot).toBe(true)
    expect(r5.count).toBe(TOOL_LOOP_PIVOT_THRESHOLD)
  })

  test("scenario: near-identical find flag tweaks collapse", () => {
    const cmds = [
      "find . -name mapping-data.ts",
      'find . -name "*mapping*" -type f',
      'find . -name "*mapping-data*" -type f',
    ]
    const history = cmds.slice(0, 2).map((c) => empty("bash", { command: c }))
    const next = { tool: "bash", input: { command: cmds[2] } }
    expect(countNoProgressStreak(history, next)).toBe(3)
    expect(evaluateToolLoop(history, next).refuse).toBe(true)
  })

  test("scenario: bash find ↔ glob same needle (cross-tool)", () => {
    const history = [
      empty("bash", { command: 'find . -name "*mapping-data*"' }),
      empty("glob", { pattern: "**/*mapping-data*" }),
    ]
    const next = { tool: "bash", input: { command: "find . -name mapping-data.ts" } }
    expect(toolLoopKeysRelated(toolLoopKey("bash", history[0]!.input), toolLoopKey("glob", history[1]!.input))).toBe(
      true,
    )
    expect(evaluateToolLoop(history, next).refuse).toBe(true)
    expect(evaluateToolLoop(history, next).reason).toBe("streak")
  })

  test("scenario: real progress (changing test output) does not refuse early", () => {
    const args = { command: "npm test" }
    const history = [ok("bash", args, "2 failing"), ok("bash", args, "1 failing")]
    expect(evaluateToolLoop(history, { tool: "bash", input: args }).refuse).toBe(false)
  })

  test("scenario: fake progress / flake same command still caps", () => {
    const args = { command: "npm test" }
    const history = Array.from({ length: TOOL_LOOP_FAKE_PROGRESS_CAP - 1 }, (_, i) =>
      ok("bash", args, `fail flake ${i}`),
    )
    const d = evaluateToolLoop(history, { tool: "bash", input: args })
    expect(d.refuse).toBe(true)
    expect(d.pivot).toBe(true)
    expect(d.reason).toBe("fake_progress")
  })

  test("scenario: identical error retries count as no progress", () => {
    const args = { command: "cat /missing" }
    const history = [err("bash", args), err("bash", args)]
    expect(evaluateToolLoop(history, { tool: "bash", input: args }).refuse).toBe(true)
  })

  test("scenario: A↔B oscillation (read ↔ edit) refuses", () => {
    const read = { path: "src/a.ts" }
    const edit = { path: "src/a.ts", content: "x" }
    const history = [
      empty("read", read),
      empty("edit", edit),
      empty("read", read),
    ]
    const next = { tool: "edit", input: edit }
    expect(countOscillationStreak(history, next)).toBeGreaterThanOrEqual(TOOL_LOOP_OSCILLATION_REFUSE)
    const d = evaluateToolLoop(history, next)
    expect(d.refuse).toBe(true)
    expect(d.reason).toBe("oscillation")
  })

  test("scenario: different tools for different goals do not refuse", () => {
    const history = [
      ok("bash", { command: "ls src" }, "a.ts\nb.ts"),
      ok("read", { path: "src/a.ts" }, "export const a = 1"),
    ]
    expect(evaluateToolLoop(history, { tool: "bash", input: { command: "npm test" } }).refuse).toBe(false)
  })

  test("scenario: after pivot, banned signature stays refused", () => {
    const args = { command: "find . -name mapping-data.ts" }
    const key = toolLoopKey("bash", args)
    requestToolLoopPivot("sess", { tool: "bash", count: 5, key })
    expect(peekToolLoopPivot("sess")).toBeTruthy()
    takeToolLoopPivot("sess") // text-only turn consumes pivot flag
    const again = evaluateToolLoop([empty("bash", args)], { tool: "bash", input: args }, { sessionID: "sess" })
    expect(again.refuse).toBe(true)
    expect(again.reason).toBe("banned")
    // glob same needle also banned
    const glob = evaluateToolLoop([], { tool: "glob", input: { pattern: "**/*mapping-data*" } }, { sessionID: "sess" })
    expect(glob.refuse).toBe(true)
    expect(glob.reason).toBe("banned")
  })

  test("scenario: pivot steer text is explicit", () => {
    const text = buildToolLoopPivotSteerText({ tool: "bash", count: 5 })
    expect(text).toContain("[tool_loop_pivot]")
    expect(text).toContain("no tools")
    expect(text).toMatch(/Pivot|different/i)
  })

  test("scenario: ToolLoopAbortError fatal vs refuse messaging", () => {
    const soft = new ToolLoopAbortError("bash", 3)
    const hard = new ToolLoopAbortError("bash", 5, { fatal: true, key: "search\0mapping" })
    expect(ToolLoopAbortError.isFatal(soft)).toBe(false)
    expect(ToolLoopAbortError.isFatal(hard)).toBe(true)
    expect(hard.message).toContain("text-only pivot")
    expect(soft.message).toContain("Pivot:")
  })

  test("scenario: pending parts ignored in history extraction", () => {
    const inv = toolInvocationsFromMessages([
      {
        parts: [
          { type: "tool", tool: "bash", state: { status: "pending", input: { command: "x" } } },
          { type: "text", text: "hi" },
          {
            type: "tool",
            tool: "bash",
            state: { status: "completed", input: { command: "ls" }, output: "a" },
          },
        ],
      },
    ])
    expect(inv).toHaveLength(1)
  })

  test("scenario: switching search needle resets streak", () => {
    const history = [
      empty("bash", { command: "find . -name foo.ts" }),
      empty("bash", { command: "find . -name foo.ts" }),
    ]
    const next = { tool: "bash", input: { command: "find . -name bar.ts" } }
    expect(evaluateToolLoop(history, next).refuse).toBe(false)
  })

  test("scenario: ban without related key does not block unrelated tools", () => {
    banToolLoopKey("sess", toolLoopKey("bash", { command: "find . -name mapping-data.ts" }))
    const d = evaluateToolLoop([], { tool: "bash", input: { command: "npm test" } }, { sessionID: "sess" })
    expect(d.refuse).toBe(false)
  })
})
