import { describe, expect, test } from "bun:test"
import {
  clearManthanPromptProgressStore,
  ingestManthanProgressSseComments,
  manthanSessionProgressUrl,
  normalizeManthanPrefillProgress,
  peekManthanPromptProgress,
} from "./manthan"

describe("ingestManthanProgressSseComments", () => {
  test("parses complete comment blocks and carries partial", () => {
    clearManthanPromptProgressStore()
    const sessionID = "ses_test_progress"
    const payload = {
      object: "manthan.progress",
      request_id: "j1",
      stage: "prompt_eval",
      message: "Prefilling 100 / 1000 tokens…",
      elapsed_ms: 12,
      prompt_tokens: 1000,
      prompt_tokens_processed: 100,
      percent: 10,
    }
    const full = `: manthan-progress ${JSON.stringify(payload)}\n\n`
    const mid = full.slice(0, 40)
    const rest = full.slice(40)
    const carry = ingestManthanProgressSseComments(sessionID, mid)
    expect(peekManthanPromptProgress(sessionID)).toBeUndefined()
    expect(carry.length).toBeGreaterThan(0)
    ingestManthanProgressSseComments(sessionID, carry + rest)
    const got = peekManthanPromptProgress(sessionID)
    expect(got?.percent).toBe(10)
    expect(got?.prompt_tokens).toBe(1000)
    expect(got?.prompt_tokens_processed).toBe(100)
  })
})

describe("normalizeManthanPrefillProgress", () => {
  test("drops fake 2048/2048 then 4096/4096 denominators", () => {
    const a = normalizeManthanPrefillProgress({
      sessionID: "s1",
      percent: 100,
      prompt_tokens: 2048,
      prompt_tokens_processed: 2048,
      prompt_tokens_cached: 0,
      stage: "prompt_eval",
      message: "Prefilling 2,048 / 2,048 tokens…",
      updated_at: 1,
    })
    expect(a.prompt_tokens).toBeNull()
    expect(a.prompt_tokens_processed).toBe(2048)
    expect(a.percent).toBeNull()
    expect(a.message).toBe("Prefilling 2,048 / 2,048 tokens…")

    const b = normalizeManthanPrefillProgress(
      {
        sessionID: "s1",
        percent: 100,
        prompt_tokens: 4096,
        prompt_tokens_processed: 4096,
        prompt_tokens_cached: 0,
        stage: "prompt_eval",
        message: "Prefilling 4,096 / 4,096 tokens…",
        updated_at: 2,
      },
      a,
    )
    expect(b.prompt_tokens).toBeNull()
    expect(b.prompt_tokens_processed).toBe(4096)
    expect(b.percent).toBeNull()
    expect(b.message).toBe("Prefilling 4,096 / 4,096 tokens…")
  })

  test("keeps real processed < total", () => {
    const p = normalizeManthanPrefillProgress({
      sessionID: "s1",
      percent: 17,
      prompt_tokens: 12000,
      prompt_tokens_processed: 2048,
      prompt_tokens_cached: 0,
      stage: "prompt_eval",
      message: null,
      updated_at: 1,
    })
    expect(p.prompt_tokens).toBe(12000)
    expect(p.prompt_tokens_processed).toBe(2048)
    expect(p.percent).toBe(17)
    expect(p.message).toBeNull()
  })

  test("compaction stage does not clobber prefill percent", () => {
    const prefill = normalizeManthanPrefillProgress({
      sessionID: "s1",
      percent: 17,
      prompt_tokens: 12000,
      prompt_tokens_processed: 2048,
      prompt_tokens_cached: 0,
      stage: "prompt_eval",
      message: null,
      updated_at: 1,
    })
    const compacted = normalizeManthanPrefillProgress(
      {
        sessionID: "s1",
        percent: 40,
        prompt_tokens: 6633,
        prompt_tokens_processed: 40,
        prompt_tokens_cached: 0,
        stage: "compaction",
        message: "Compressing old tool output…",
        updated_at: 2,
      },
      prefill,
    )
    expect(compacted.percent).toBe(17)
    expect(compacted.prompt_tokens).toBe(12000)
    expect(compacted.message).toBe("Compressing old tool output…")
  })
})

describe("manthanSessionProgressUrl", () => {
  test("maps chat completions URL to session progress", () => {
    expect(manthanSessionProgressUrl("http://127.0.0.1:3000/v1/chat/completions", "ses_1")).toBe(
      "http://127.0.0.1:3000/v1/sessions/ses_1/progress",
    )
  })
})
