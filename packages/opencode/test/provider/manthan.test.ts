import { afterEach, describe, expect, test } from "bun:test"
import {
  applyManthanOptionA,
  clearManthanCompactQueue,
  clearManthanContextStore,
  consumeManthanCompact,
  ensureManthanClientHeaders,
  formatManthanContextLabel,
  isManthanConfig,
  isManthanProviderID,
  manthanSessionHeaders,
  parseManthanContextHeaders,
  rememberManthanContext,
  requestManthanCompact,
  sessionIDFromRequestHeaders,
  takeManthanContext,
} from "../../src/provider/manthan"

afterEach(() => {
  clearManthanContextStore()
  clearManthanCompactQueue()
})

describe("manthan Option A", () => {
  test("isManthanProviderID matches manthan ids", () => {
    expect(isManthanProviderID("manthan")).toBe(true)
    expect(isManthanProviderID("manthan/laguna-xs-2.1-sharded")).toBe(true)
    expect(isManthanProviderID("openai")).toBe(false)
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

  test("parseManthanContextHeaders reads context bar fields", () => {
    const usage = parseManthanContextHeaders({
      "x-manthan-context-limit": "65536",
      "x-manthan-context-used": "12345",
      "x-manthan-context-usage-percent": "42.5",
      "x-manthan-compaction-status": "compacted",
      "x-manthan-cache-epoch": "3",
      "x-manthan-newly-evaluated-tokens": "800",
    })
    expect(usage).not.toBeNull()
    expect(usage!.context_limit).toBe(65536)
    expect(usage!.context_used).toBe(12345)
    expect(usage!.context_usage_percent).toBe(42.5)
    expect(usage!.compaction_status).toBe("compacted")
    expect(usage!.cache_epoch).toBe(3)
    expect(formatManthanContextLabel(usage!)).toBe("12,345 (43%)")
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

  test("sessionIDFromRequestHeaders prefers opencode session id", () => {
    expect(
      sessionIDFromRequestHeaders({
        "x-opencode-session-id": "ses_a",
        "x-session-affinity": "ses_b",
      }),
    ).toBe("ses_a")
  })

  test("request/consume Manthan compact is one-shot", () => {
    requestManthanCompact("ses_c")
    expect(consumeManthanCompact("ses_c")).toBe(true)
    expect(consumeManthanCompact("ses_c")).toBe(false)
  })

  test("manthanSessionHeaders brands X-Title as Manthan", () => {
    expect(manthanSessionHeaders("ses_x")["X-Title"]).toBe("Manthan")
  })
})
