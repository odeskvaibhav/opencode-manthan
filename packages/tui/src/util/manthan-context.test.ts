import { describe, expect, test } from "bun:test"
import {
  compactAtFromModel,
  findManthanProvider,
  hasManthanProvider,
  waitForManthanGpuFromProvider,
  leaveManthanGpuFromProvider,
  formatManthanContextLabel,
  formatWarmupProgressLine,
  isManthanLaunchMode,
  isManthanProviderID,
  manthanEnsureReadyRequest,
  manthanCompactAnchorForMessage,
  manthanCompactDividerForMessage,
  manthanCompactSummaryForMessage,
  manthanContextFromMetadata,
  manthanHasSummarised,
  manthanLatestSummary,
  nextWarmupRotateLine,
  WARMUP_ROTATE_LINES,
  manthanSummarisedLabel,
  resolveCompactionThreshold,
  clearSharedCompactionThreshold,
  noteSharedCompactionThreshold,
  getSharedCompactionThreshold,
} from "./manthan-context"

describe("tui manthan context", () => {
  test("isManthanProviderID / findManthanProvider / hasManthanProvider", () => {
    expect(isManthanProviderID("manthan")).toBe(true)
    expect(isManthanProviderID("opencode")).toBe(false)
    const providers = [
      { id: "opencode", models: { "big-pickle": {} } },
      { id: "manthan", models: { "laguna-xs-2.1-sharded": {} } },
    ]
    expect(findManthanProvider(providers)?.id).toBe("manthan")
    expect(findManthanProvider([{ id: "manthan", models: {} }])).toBeUndefined()
    expect(hasManthanProvider([{ id: "manthan" }])).toBe(true)
    expect(hasManthanProvider([{ id: "opencode" }])).toBe(false)
  })

  test("leaveManthanGpuFromProvider POSTs leave", async () => {
    const orig = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls.push(String(init?.body ?? ""))
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    try {
      leaveManthanGpuFromProvider({ id: "manthan", key: "k", options: { baseURL: "http://x/v1" } })
      await new Promise((r) => setTimeout(r, 10))
      expect(calls.some((b) => b.includes('"leave"'))).toBe(true)
    } finally {
      globalThis.fetch = orig
    }
  })

  test("waitForManthanGpuFromProvider polls until ready", async () => {
    const orig = globalThis.fetch
    let n = 0
    globalThis.fetch = (async () => {
      n++
      return new Response(JSON.stringify({ ready: n > 1, status: n > 1 ? "ready" : "waking" }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    try {
      const r = await waitForManthanGpuFromProvider(
        { id: "manthan", key: "k", options: { baseURL: "http://x/v1" } },
        { timeoutMs: 2000, pollMs: 5 },
      )
      expect(r).toBe("ready")
      expect(n).toBeGreaterThan(1)
    } finally {
      globalThis.fetch = orig
    }
  })

  test("manthanEnsureReadyRequest is POST launch after model pick", () => {
    expect(manthanEnsureReadyRequest({ id: "opencode", options: { baseURL: "http://x/v1" } })).toBeNull()
    const req = manthanEnsureReadyRequest({
      id: "manthan",
      key: "member-key",
      options: { baseURL: "http://8.234.66.134:3000/v1/" },
    })
    expect(req?.url).toBe("http://8.234.66.134:3000/v1/workers/ensure-ready")
    expect(req?.headers.Authorization).toBe("Bearer member-key")
  })

  test("isManthanLaunchMode reads OPENCODE_MANTHAN_MODE", () => {
    const prev = process.env.OPENCODE_MANTHAN_MODE
    process.env.OPENCODE_MANTHAN_MODE = "1"
    expect(isManthanLaunchMode()).toBe(true)
    process.env.OPENCODE_MANTHAN_MODE = "0"
    expect(isManthanLaunchMode()).toBe(false)
    if (prev === undefined) delete process.env.OPENCODE_MANTHAN_MODE
    else process.env.OPENCODE_MANTHAN_MODE = prev
  })

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

  test("compact marker drives Chat context summarised divider", () => {
    const usage = manthanContextFromMetadata({
      manthan: {
        context_used: 8100,
        context_limit: 20000,
        context_usage_percent: 54,
        compact_markers: [
          { messageID: "msg_user", epoch: 2, at: 1, summary: "Current task: wire auth\nFiles read: a.ts" },
        ],
      },
    })
    expect(usage?.compact_markers[0]?.summary).toBe("Current task: wire auth\nFiles read: a.ts")
    expect(manthanCompactDividerForMessage("msg_user", usage)).toBe(true)
    expect(manthanCompactSummaryForMessage("msg_user", usage)).toBe("Current task: wire auth\nFiles read: a.ts")
    expect(manthanCompactDividerForMessage("msg_other", usage)).toBe(false)
    expect(manthanCompactSummaryForMessage("msg_other", usage)).toBeNull()
  })

  test("compacted status shows trip percent when known", () => {
    const usage = manthanContextFromMetadata({
      manthan: {
        context_used: 12700,
        context_limit: 64000,
        context_usage_percent: 22,
        compaction_threshold: 80,
        compaction_status: "compacted",
        compact_usage_before_percent: 83,
      },
    })
    expect(formatManthanContextLabel(usage!)).toBe(
      "12.7K / 64.0K (22%) · compact@80% · compacted from 83%",
    )
  })

  test("orphan compact status still anchors on last user (subagent)", () => {
    const usage = manthanContextFromMetadata({
      manthan: {
        context_used: 9000,
        context_limit: 20000,
        compaction_status: "compacted",
        compact_summary: "Current task: explore repo",
      },
    })
    const users = ["msg_a", "msg_b"]
    expect(manthanCompactAnchorForMessage("msg_a", users, usage).show).toBe(false)
    const last = manthanCompactAnchorForMessage("msg_b", users, usage)
    expect(last.show).toBe(true)
    expect(last.summary).toBe("Current task: explore repo")
    expect(manthanHasSummarised(usage)).toBe(true)
    expect(manthanLatestSummary(usage)).toBe("Current task: explore repo")
  })

  test("manthanSummarisedLabel distinguishes subagent vs main", () => {
    expect(manthanSummarisedLabel(false)).toBe("Chat context summarised")
    expect(manthanSummarisedLabel(true)).toBe("Subagent context summarised")
  })

  test("shared compaction threshold keeps parent/child footers aligned", () => {
    clearSharedCompactionThreshold()
    expect(resolveCompactionThreshold(80, null, 1)).toBe(80)
    expect(getSharedCompactionThreshold()).toBe(80)
    noteSharedCompactionThreshold(50, 2)
    expect(resolveCompactionThreshold(80, null, 1)).toBe(50)
    expect(
      formatManthanContextLabel({
        context_limit: 65536,
        context_used: 7300,
        context_usable: null,
        context_remaining: null,
        context_usage_percent: 12,
        compaction_threshold: 80,
        compaction_status: "ok",
        cache_epoch: null,
        newly_evaluated_tokens: null,
        cache_reuse_percent: null,
        compact_summary: null,
        compact_markers: [],
        compact_reason: null,
        compact_usage_before_percent: null,
        updated_at: 1,
      }),
    ).toBe("7.3K / 65.5K (12%) · compact@50%")
    clearSharedCompactionThreshold()
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

  test("nextWarmupRotateLine cycles off the previous line", () => {
    const a = nextWarmupRotateLine(null)
    expect(WARMUP_ROTATE_LINES).toContain(a)
    const b = nextWarmupRotateLine(a)
    expect(WARMUP_ROTATE_LINES).toContain(b)
    expect(b).not.toBe(a)
  })
})
