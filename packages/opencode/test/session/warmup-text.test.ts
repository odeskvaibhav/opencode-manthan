import { describe, expect, test } from "bun:test"
import { isWarmupOrCapabilityAsk, MANTHAN_WARMUP_LINE, userAskText } from "../../src/session/warmup-text"

describe("warmup-text", () => {
  test("matches New Chat warmup line", () => {
    expect(isWarmupOrCapabilityAsk(MANTHAN_WARMUP_LINE)).toBe(true)
  })

  test("matches short capability asks", () => {
    expect(isWarmupOrCapabilityAsk("What can you do?")).toBe(true)
    expect(isWarmupOrCapabilityAsk("Hi, what can you do for me?")).toBe(true)
  })

  test("does not match real work asks", () => {
    expect(isWarmupOrCapabilityAsk("Can you fix the bug in auth?")).toBe(false)
    expect(isWarmupOrCapabilityAsk("implement portfolio app")).toBe(false)
    expect(isWarmupOrCapabilityAsk("What files can you help me search for?")).toBe(false)
  })

  test("userAskText skips synthetic parts", () => {
    expect(
      userAskText([
        { type: "text", text: "hidden", synthetic: true },
        { type: "text", text: MANTHAN_WARMUP_LINE },
        { type: "file" },
      ]),
    ).toBe(MANTHAN_WARMUP_LINE)
  })
})
