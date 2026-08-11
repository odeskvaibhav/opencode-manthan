import { afterEach, describe, expect, test } from "bun:test"
import {
  applyManthanModelPolicies,
  applyManthanOptionA,
  clearManthanCompactQueue,
  clearManthanContextStore,
  consumeManthanCompact,
  ensureManthanClientHeaders,
  formatManthanContextLabel,
  isManthanConfig,
  isManthanProviderID,
  manthanReasoningEffort,
  manthanSessionHeaders,
  decodeManthanCompactSummaryHeader,
  nextManthanCompactMarkers,
  parseManthanCompactMarkers,
  parseManthanContextHeaders,
  rememberManthanContext,
  requestManthanCompact,
  sessionIDFromFetch,
  sessionIDFromRequestHeaders,
  takeManthanContext,
  shouldManthanCompactAutocontinue,
  manthanSessionCancelUrl,
  rememberManthanCancelTarget,
  clearManthanCancelTarget,
} from "../../src/provider/manthan"

afterEach(() => {
  clearManthanContextStore()
  clearManthanCompactQueue()
})

describe("manthan Option A", () => {
  test("isManthanProviderID matches manthan ids", () => {
    expect(isManthanProviderID("manthan")).toBe(true)
    expect(isManthanProviderID("manthan/laguna-xs-2.1-sharded")).toBe(true)
    expect(isManthanProviderID("custom/manthan/laguna")).toBe(true)
    expect(isManthanProviderID("openai")).toBe(false)
    expect(isManthanProviderID("anthropic")).toBe(false)
  })

  test("isManthanConfig detects model, provider id, and client header", () => {
    expect(isManthanConfig({ model: "manthan/laguna-xs-2.1-sharded" })).toBe(true)
    expect(
      isManthanConfig({
        provider: { manthan: { name: "Manthan AI", options: { baseURL: "http://127.0.0.1:3000/v1" } } },
      }),
    ).toBe(true)
    expect(
      isManthanConfig({
        provider: {
          custom: {
            options: { headers: { "X-Manthan-Client": "opencode" } },
          },
        },
      }),
    ).toBe(true)
    expect(isManthanConfig({ model: "openai/gpt-4o", provider: { openai: {} } })).toBe(false)
  })

  test("applyManthanOptionA disables auto compact and prune", () => {
    const next = applyManthanOptionA({
      model: "manthan/laguna",
      compaction: { auto: true, prune: true, reserved: 19661 },
    })
    expect(next.compaction?.auto).toBe(false)
    expect(next.compaction?.prune).toBe(false)
    expect(next.compaction?.reserved).toBe(19661)
  })

  test("applyManthanOptionA no-ops for non-Manthan", () => {
    const cfg = { model: "openai/gpt-4o", compaction: { auto: true } }
    expect(applyManthanOptionA(cfg)).toEqual(cfg)
  })

  test("applyManthanOptionA respects ALLOW_CLIENT_COMPACT escape hatch", () => {
    const prev = process.env.OPENCODE_MANTHAN_ALLOW_CLIENT_COMPACT
    process.env.OPENCODE_MANTHAN_ALLOW_CLIENT_COMPACT = "1"
    try {
      const next = applyManthanOptionA({
        model: "manthan/laguna",
        compaction: { auto: true, prune: true },
      })
      expect(next.compaction?.auto).toBe(true)
      expect(next.compaction?.prune).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_MANTHAN_ALLOW_CLIENT_COMPACT
      else process.env.OPENCODE_MANTHAN_ALLOW_CLIENT_COMPACT = prev
    }
  })

  test("ensureManthanClientHeaders sets identity for manthan provider", () => {
    const h = ensureManthanClientHeaders({}, "manthan")
    expect(h["x-manthan-client"]).toBe("opencode")
  })

  test("manthanSessionHeaders includes affinity aliases", () => {
    const h = manthanSessionHeaders("ses_abc")
    expect(h["x-opencode-session"]).toBe("ses_abc")
    expect(h["x-opencode-session-id"]).toBe("ses_abc")
    expect(h["x-session-affinity"]).toBe("ses_abc")
    expect(h["x-manthan-client"]).toBe("opencode")
  })

  test("applyManthanModelPolicies overlays /v1/models window + compact %", () => {
    const models: Record<string, { id: string; limit: { context: number }; options?: Record<string, unknown> }> = {
      "laguna-xs-2.1-sharded": {
        id: "laguna-xs-2.1-sharded",
        limit: { context: 65536 },
        options: { temperature: 0.1 },
      },
    }
    const policies = new Map([
      ["laguna-xs-2.1-sharded", { context_limit: 10000, compaction_threshold: 50 }],
    ])
    expect(applyManthanModelPolicies(models, policies)).toBe(1)
    expect(models["laguna-xs-2.1-sharded"].limit.context).toBe(10000)
    expect(models["laguna-xs-2.1-sharded"].options?.compaction_threshold).toBe(50)
  })

  test("parseManthanContextHeaders reads context bar fields", () => {
    const usage = parseManthanContextHeaders({
      "x-manthan-context-limit": "65536",
      "x-manthan-context-used": "12345",
      "x-manthan-context-usage-percent": "42.5",
      "x-manthan-compaction-threshold": "96",
      "x-manthan-compaction-status": "compacted",
      "x-manthan-cache-epoch": "3",
      "x-manthan-newly-evaluated-tokens": "800",
    })
    expect(usage).not.toBeNull()
    expect(usage!.context_limit).toBe(65536)
    expect(usage!.context_used).toBe(12345)
    expect(usage!.context_usage_percent).toBe(42.5)
    expect(usage!.compaction_threshold).toBe(96)
    expect(usage!.compaction_status).toBe("compacted")
    expect(usage!.cache_epoch).toBe(3)
    expect(usage!.compact_summary).toBeNull()
    expect(formatManthanContextLabel(usage!)).toBe("12,345 / 65,536 · 43% · compact@96%")
  })

  test("parseManthanContextHeaders returns null without Manthan headers", () => {
    expect(parseManthanContextHeaders({ "content-type": "application/json" })).toBeNull()
  })

  test("remember/take Manthan context handoff", () => {
    const usage = parseManthanContextHeaders({
      "x-manthan-context-used": "100",
      "x-manthan-context-usage-percent": "10",
    })!
    rememberManthanContext("ses_1", usage)
    expect(takeManthanContext("ses_1")?.context_used).toBe(100)
    expect(takeManthanContext("ses_1")).toBeUndefined()
  })

  test("remember/take works via session id alias (subagent)", () => {
    const usage = parseManthanContextHeaders({
      "x-manthan-context-used": "200",
      "x-manthan-compaction-status": "compacted",
    })!
    rememberManthanContext("ses_parent_affinity", usage, ["ses_child_subagent"])
    expect(takeManthanContext("ses_child_subagent")?.compaction_status).toBe("compacted")
    expect(takeManthanContext("ses_parent_affinity")).toBeUndefined()
  })

  test("sessionIDFromRequestHeaders prefers opencode session id", () => {
    expect(
      sessionIDFromRequestHeaders({
        "x-opencode-session-id": "ses_a",
        "x-session-affinity": "ses_b",
      }),
    ).toBe("ses_a")
  })

  test("sessionIDFromFetch reads Request and response headers", () => {
    const req = new Request("http://127.0.0.1/v1/chat/completions", {
      headers: { "x-opencode-session-id": "ses_req" },
    })
    expect(sessionIDFromFetch({ request: req })).toBe("ses_req")
    expect(
      sessionIDFromFetch({
        response: new Headers({ "x-session-id": "ses_res" }),
      }),
    ).toBe("ses_res")
  })

  test("decodeManthanCompactSummaryHeader reads base64 summary", () => {
    const summary = "Current task: wire auth\nFiles read: src/a.ts"
    const b64 = Buffer.from(summary, "utf8").toString("base64")
    expect(
      decodeManthanCompactSummaryHeader({
        "x-manthan-compact-summary-b64": b64,
      }),
    ).toBe(summary)
    expect(
      parseManthanContextHeaders({
        "x-manthan-context-used": "100",
        "x-manthan-compact-summary-b64": b64,
      })?.compact_summary,
    ).toBe(summary)
  })

  test("nextManthanCompactMarkers records one divider per compact epoch", () => {
    const first = nextManthanCompactMarkers([], {
      compactionStatus: "compacted",
      epoch: 1,
      messageID: "msg_a",
      at: 10,
      summary: "Current task: wire auth",
    })
    expect(first.added).toBe(true)
    expect(first.markers).toEqual([
      { messageID: "msg_a", epoch: 1, at: 10, summary: "Current task: wire auth" },
    ])

    const sameEpoch = nextManthanCompactMarkers(first.markers, {
      compactionStatus: "compacted",
      epoch: 1,
      messageID: "msg_b",
      at: 20,
      summary: "Current task: wire auth",
    })
    expect(sameEpoch.added).toBe(false)

    const nextEpoch = nextManthanCompactMarkers(first.markers, {
      compactionStatus: "compacted",
      epoch: 2,
      messageID: "msg_c",
      at: 30,
      summary: "Current task: continue",
    })
    expect(nextEpoch.added).toBe(true)
    expect(nextEpoch.markers).toHaveLength(2)

    const growing = nextManthanCompactMarkers(nextEpoch.markers, {
      compactionStatus: "growing",
      epoch: 2,
      messageID: "msg_d",
    })
    expect(growing.added).toBe(false)
    expect(parseManthanCompactMarkers(nextEpoch.markers)).toHaveLength(2)

    const emptyFalsePositive = nextManthanCompactMarkers(first.markers, {
      compactionStatus: "compacted",
      epoch: 3,
      messageID: "msg_empty",
      at: 40,
    })
    expect(emptyFalsePositive.added).toBe(false)

    const reasonOnly = nextManthanCompactMarkers(first.markers, {
      compactionStatus: "compacted",
      epoch: 3,
      messageID: "msg_reason",
      at: 41,
      compactReason: "threshold",
    })
    expect(reasonOnly.added).toBe(false)

    const backToBack = nextManthanCompactMarkers(first.markers, {
      compactionStatus: "compacted",
      epoch: 2,
      messageID: "msg_dup",
      at: 10 + 5_000,
      summary: "Current task: wire auth\nMore detail",
    })
    expect(backToBack.added).toBe(false)
  })

  test("nextManthanCompactMarkers still adds when user message id is missing", () => {
    const orphan = nextManthanCompactMarkers([], {
      compactionStatus: "compacted",
      epoch: 4,
      messageID: undefined,
      at: 40,
      summary: "Current task: explore repo",
    })
    expect(orphan.added).toBe(true)
    expect(orphan.markers[0]?.messageID).toBe("__manthan_orphan_4")
    expect(orphan.markers[0]?.summary).toBe("Current task: explore repo")
  })

  test("shouldManthanCompactAutocontinue only when compact added and turn would exit", () => {
    expect(shouldManthanCompactAutocontinue({ added: true, finish: "stop" })).toBe(true)
    expect(shouldManthanCompactAutocontinue({ added: true, finish: "length" })).toBe(true)
    expect(shouldManthanCompactAutocontinue({ added: false, finish: "stop" })).toBe(false)
    expect(shouldManthanCompactAutocontinue({ added: true, finish: "tool-calls" })).toBe(false)
    expect(shouldManthanCompactAutocontinue({ added: true, finish: "stop", error: { name: "x" } })).toBe(false)
  })

  test("manthanSessionCancelUrl maps chat completions to sessions/cancel", () => {
    expect(manthanSessionCancelUrl("http://host:3000/v1/chat/completions")).toBe(
      "http://host:3000/v1/sessions/cancel",
    )
    rememberManthanCancelTarget({
      sessionID: "ses_cancel",
      chatUrl: "http://host:3000/v1/chat/completions",
      headers: { Authorization: "Bearer t" },
    })
    clearManthanCancelTarget("ses_cancel")
  })

  test("request/consume Manthan compact is one-shot", () => {
    requestManthanCompact("ses_c")
    expect(consumeManthanCompact("ses_c")).toBe(true)
    expect(consumeManthanCompact("ses_c")).toBe(false)
  })

  test("manthanSessionHeaders brands X-Title as Manthan", () => {
    expect(manthanSessionHeaders("ses_x")["X-Title"]).toBe("Manthan")
  })

  test("manthanReasoningEffort prefers agent medium over missing user variant", () => {
    expect(
      manthanReasoningEffort({
        agent: { variant: "medium", options: { reasoningEffort: "medium" } },
      }),
    ).toBe("medium")
  })

  test("manthanReasoningEffort uses explicit user variant", () => {
    expect(
      manthanReasoningEffort({
        userVariant: "low",
        agent: { variant: "medium" },
      }),
    ).toBe("low")
  })

  test("manthanReasoningEffort defaults to medium when unset", () => {
    expect(manthanReasoningEffort({})).toBe("medium")
  })
})
