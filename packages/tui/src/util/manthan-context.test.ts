import { describe, expect, test } from "bun:test"
import { formatManthanContextLabel, manthanContextFromMetadata } from "./manthan-context"

describe("tui manthan context", () => {
  test("reads metadata.manthan and formats label", () => {
    const usage = manthanContextFromMetadata({
      manthan: {
        context_used: 24000,
        context_usage_percent: 36.7,
        compaction_status: "ok",
      },
    })
    expect(usage?.context_used).toBe(24000)
    expect(formatManthanContextLabel(usage!)).toBe("24,000 (37%)")
  })

  test("returns null without manthan metadata", () => {
    expect(manthanContextFromMetadata({})).toBeNull()
    expect(manthanContextFromMetadata(undefined)).toBeNull()
  })
})
