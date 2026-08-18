import { describe, expect, test } from "bun:test"
import { buildManthanConfigContent, formatStatusBar, manthanCliCommand, parseSessionListForManthan } from "./manthan-config"

describe("vscode manthan helpers", () => {
  test("manthanCliCommand pins workspace directory", () => {
    expect(manthanCliCommand("manthan", 4096)).toBe("manthan --port 4096")
    expect(manthanCliCommand("manthan", 4096, "/Users/me/app")).toBe('manthan --port 4096 "/Users/me/app"')
    expect(manthanCliCommand("/tmp/my bin/manthan", 1, "/tmp/work space")).toBe(
      `"/tmp/my bin/manthan" --port 1 "/tmp/work space"`,
    )
  })

  test("buildManthanConfigContent forces Option A compaction off", () => {
    const raw = buildManthanConfigContent({
      baseUrl: "http://127.0.0.1:3000/v1",
      apiKey: "test-key",
      model: "manthan/laguna-xs-2.1-sharded",
      binary: "opencode",
      showPowerFields: false,
      openFilesOnEdit: true,
      autoCloseEditedFiles: true,
      editHighlightMs: 1100,
      openOnEditStealFocus: false,
    })
    const cfg = JSON.parse(raw) as {
      model?: string
      compaction: { auto: boolean; prune: boolean }
      agent?: { build?: { variant?: string; options?: { reasoningEffort?: string } } }
      provider: { manthan: { options: { headers: Record<string, string> }; models: Record<string, unknown> } }
    }
    expect(cfg.compaction.auto).toBe(false)
    expect(cfg.compaction.prune).toBe(false)
    expect(cfg.provider.manthan.options.headers["X-Manthan-Client"]).toBe("opencode")
    expect(cfg.provider.manthan.options.headers["X-Manthan-Reasoning-Effort"]).toBe("medium")
    expect(cfg.agent?.build?.variant).toBe("medium")
    expect(cfg.agent?.build?.options?.reasoningEffort).toBe("medium")
    expect(cfg.model).toBe("manthan/laguna-xs-2.1-sharded")
  })

  test("buildManthanConfigContent omits model pin when unset", () => {
    const raw = buildManthanConfigContent({
      baseUrl: "http://127.0.0.1:3000/v1",
      apiKey: "test-key",
      model: "",
      binary: "opencode",
      showPowerFields: false,
      openFilesOnEdit: true,
      autoCloseEditedFiles: true,
      editHighlightMs: 1100,
      openOnEditStealFocus: false,
    })
    const cfg = JSON.parse(raw) as {
      model?: string
      agent?: { build?: { variant?: string } }
      provider: { manthan: { models: Record<string, unknown> } }
    }
    expect(cfg.model).toBeUndefined()
    expect(cfg.agent?.build?.variant).toBe("medium")
    expect(cfg.provider.manthan.models).toEqual({})
  })

  test("formatStatusBar includes power fields when enabled", () => {
    const snap = {
      used: 12000,
      limit: 8192,
      percent: 50,
      compactAt: 40,
      status: "compacted",
      fresh: 800,
      reuse: 70,
      epoch: 2,
    }
    expect(formatStatusBar(snap, false)).toContain("12,000 / 8,192 (50%)")
    expect(formatStatusBar(snap, false)).toContain("compact@40%")
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
        metadata: {
          manthan: {
            context_used: 99,
            context_limit: 8192,
            context_usage_percent: 12,
            compaction_threshold: 40,
          },
        },
      },
    ])
    expect(snap?.used).toBe(99)
    expect(snap?.limit).toBe(8192)
    expect(snap?.percent).toBe(12)
    expect(snap?.compactAt).toBe(40)
  })
})
