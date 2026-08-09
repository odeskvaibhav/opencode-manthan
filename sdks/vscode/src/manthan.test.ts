import { describe, expect, test } from "bun:test"
import { buildManthanConfigContent, formatStatusBar, parseSessionListForManthan } from "./manthan-config"

describe("vscode manthan helpers", () => {
  test("buildManthanConfigContent forces Option A compaction off", () => {
    const raw = buildManthanConfigContent({
      baseUrl: "http://127.0.0.1:3000/v1",
      apiKey: "test-key",
      model: "manthan/laguna-xs-2.1-sharded",
      binary: "opencode",
      showPowerFields: false,
    })
    const cfg = JSON.parse(raw) as {
      compaction: { auto: boolean; prune: boolean }
      provider: { manthan: { options: { headers: Record<string, string> } } }
    }
    expect(cfg.compaction.auto).toBe(false)
    expect(cfg.compaction.prune).toBe(false)
    expect(cfg.provider.manthan.options.headers["X-Manthan-Client"]).toBe("opencode")
  })

  test("formatStatusBar includes power fields when enabled", () => {
    const snap = {
      used: 12000,
      percent: 50,
      status: "compacted",
      fresh: 800,
      reuse: 70,
      epoch: 2,
    }
    expect(formatStatusBar(snap, false)).toContain("12,000 (50%)")
    expect(formatStatusBar(snap, false)).toContain("compacted")
    expect(formatStatusBar(snap, true)).toContain("fresh 800")
    expect(formatStatusBar(snap, true)).toContain("reuse 70%")
    expect(formatStatusBar(snap, true)).toContain("e2")
  })

  test("parseSessionListForManthan picks newest with metadata", () => {
    const snap = parseSessionListForManthan([
      { time: { updated: 1 }, metadata: {} },
      {
        time: { updated: 9 },
        metadata: { manthan: { context_used: 99, context_usage_percent: 12 } },
      },
    ])
    expect(snap?.used).toBe(99)
    expect(snap?.percent).toBe(12)
  })
})
