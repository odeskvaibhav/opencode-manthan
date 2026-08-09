import { describe, expect, test } from "bun:test"
import {
  compactAtFromModel,
  formatManthanContextLabel,
  formatWarmupProgressLine,
  manthanContextFromMetadata,
} from "./manthan-context"

describe("tui manthan context", () => {
  test("reads metadata.manthan and formats label", () => {
    const usage = manthanContextFromMetadata({
      manthan: {
        context_used: 24000,
        context_limit: 65536,
        context_usage_percent: 36.7,
        compaction_threshold: 40,
        compaction_status: "ok",
      },
    })
    expect(usage?.context_used).toBe(24000)
    expect(usage?.context_limit).toBe(65536)
    expect(usage?.compaction_threshold).toBe(40)
    expect(formatManthanContextLabel(usage!)).toBe("24.0K / 65.5K (37%) · compact@40%")
  })

  test("returns null without manthan metadata", () => {
    expect(manthanContextFromMetadata({})).toBeNull()
    expect(manthanContextFromMetadata(undefined)).toBeNull()
  })

  test("compactAtFromModel reads /v1/models overlay", () => {
    expect(compactAtFromModel({ options: { compaction_threshold: 50 } })).toBe(50)
    expect(compactAtFromModel({ options: {} })).toBeNull()
  })

  test("formatWarmupProgressLine keeps copy and sticky percent", () => {
    expect(formatWarmupProgressLine("Thinking before touching production. Rare, but useful.", 12)).toBe(
      "Thinking before touching production. Rare, but useful. (12%)",
    )
    expect(formatWarmupProgressLine("Compressing old tool output… (8%)", 40)).toBe(
      "Compressing old tool output… (40%)",
    )
    expect(formatWarmupProgressLine("Warming model…", null)).toBe("Warming model…")
  })
})
