import { describe, expect, test } from "bun:test"
import {
  createContentLineCount,
  highlightLinesFromReveal,
  lineFromUnifiedDiff,
  lineRangeFromNeedle,
  parseSseChunk,
  refineEditReveal,
  revealFromToolPart,
} from "./open-on-edit-helpers"

describe("open-on-edit helpers", () => {
  test("lineFromUnifiedDiff reads first hunk new start (0-based)", () => {
    const diff = `--- a/x\n+++ b/x\n@@ -10,3 +12,4 @@\n line\n+new\n`
    expect(lineFromUnifiedDiff(diff)).toBe(11)
    expect(lineFromUnifiedDiff("no hunk")).toBeNull()
  })

  test("lineRangeFromNeedle finds multi-line span", () => {
    const text = "a\nb\nhello\nworld\nz\n"
    expect(lineRangeFromNeedle(text, "hello\nworld")).toEqual({ startLine: 2, endLine: 3 })
    expect(lineRangeFromNeedle(text, "missing")).toBeNull()
  })

  test("revealFromToolPart marks write create and edit hunk", () => {
    const create = revealFromToolPart({
      tool: "write",
      state: {
        status: "completed",
        input: { filePath: "/tmp/a.ts", content: "x" },
        metadata: { exists: false, filepath: "/tmp/a.ts" },
      },
    })
    expect(create?.isCreate).toBe(true)
    expect(create?.reveal).toEqual({ kind: "create" })

    const edit = revealFromToolPart({
      tool: "edit",
      state: {
        status: "completed",
        input: {
          filePath: "/tmp/b.ts",
          oldString: "old",
          newString: "one\ntwo",
        },
        metadata: {
          diff: "@@ -5,1 +5,2 @@\n-old\n+one\n+two\n",
        },
      },
    })
    expect(edit?.isCreate).toBe(false)
    expect(edit?.reveal).toEqual({ kind: "edit", startLine: 4, endLine: 5 })
  })

  test("revealFromToolPart early edit uses needle resolve marker", () => {
    const running = revealFromToolPart({
      tool: "edit",
      state: {
        status: "running",
        input: { filePath: "/tmp/c.ts", oldString: "foo", newString: "bar" },
      },
    })
    expect(running?.phase).toBe("running")
    expect(running?.reveal).toEqual({ kind: "edit", startLine: -1, endLine: -1 })
  })

  test("refineEditReveal searches newString then oldString", () => {
    const text = "alpha\nbeta\ngamma\n"
    expect(refineEditReveal(text, { kind: "edit", startLine: -1, endLine: -1 }, { newString: "beta" })).toEqual({
      kind: "edit",
      startLine: 1,
      endLine: 1,
    })
    expect(refineEditReveal(text, { kind: "create" }, {})).toEqual({ kind: "create" })
  })

  test("highlightLinesFromReveal clamps edits and spans create content", () => {
    expect(highlightLinesFromReveal({ kind: "edit", startLine: 2, endLine: 4 }, 10)).toEqual({
      startLine: 2,
      endLine: 4,
    })
    expect(highlightLinesFromReveal({ kind: "edit", startLine: -1, endLine: -1 }, 5)).toEqual({
      startLine: 0,
      endLine: 0,
    })
    expect(highlightLinesFromReveal({ kind: "edit", startLine: 8, endLine: 99 }, 5)).toEqual({
      startLine: 4,
      endLine: 4,
    })
    expect(highlightLinesFromReveal({ kind: "create" }, 20)).toEqual({ startLine: 19, endLine: 19 })
    expect(highlightLinesFromReveal({ kind: "create" }, 20, { createLineCount: 3 })).toEqual({
      startLine: 17,
      endLine: 19,
    })
    expect(createContentLineCount("a\nb\nc")).toBe(3)
    expect(createContentLineCount("")).toBeUndefined()
  })

  test("parseSseChunk extracts JSON data frames", () => {
    const events: { type?: string }[] = []
    const rest = parseSseChunk(
      'event: message\ndata: {"type":"file.edited","properties":{"file":"/a"}}\n\npartial',
      (ev) => events.push(ev),
    )
    expect(events).toEqual([{ type: "file.edited", properties: { file: "/a" } }])
    expect(rest).toBe("partial")
  })
})
