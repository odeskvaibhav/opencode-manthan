export type ManthanSettings = {
  baseUrl: string
  apiKey: string
  model: string
  binary: string
  showPowerFields: boolean
}

/** Build OPENCODE_CONFIG_CONTENT JSON for Option A Manthan profile. */
export function buildManthanConfigContent(settings: ManthanSettings): string {
  const headers: Record<string, string> = {
    "X-Manthan-Client": "opencode",
    "X-Title": "Manthan",
    "HTTP-Referer": "https://manthan.ai",
  }
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`
    headers["x-api-key"] = settings.apiKey
  }
  const modelId = settings.model.replace(/^manthan\//, "")
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: settings.model,
    compaction: {
      auto: false,
      prune: false,
    },
    provider: {
      manthan: {
        name: "Manthan AI",
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: settings.baseUrl,
          apiKey: settings.apiKey || "{env:MANTHAN_API_KEY}",
          includeUsage: true,
          timeout: 1_200_000,
          chunkTimeout: 900_000,
          headers,
        },
        models: {
          [modelId]: {
            name: settings.model,
            tool_call: true,
            reasoning: true,
            interleaved: { field: "reasoning_content" },
            limit: { context: 65536, output: 4096 },
          },
        },
      },
    },
  }
  return JSON.stringify(config)
}

export type ManthanContextSnap = {
  used: number | null
  percent: number | null
  status: string | null
  fresh: number | null
  reuse: number | null
  epoch: number | null
}

export function formatStatusBar(snap: ManthanContextSnap, power: boolean): string {
  const pct = snap.percent != null ? `${Math.round(snap.percent)}%` : "?"
  const used = snap.used != null ? Math.round(snap.used).toLocaleString("en-US") : "?"
  let text = `Manthan ${used} (${pct})`
  if (snap.status && !["ok", "none", "normal"].includes(snap.status)) text += ` · ${snap.status}`
  if (power) {
    if (snap.fresh != null) text += ` · fresh ${Math.round(snap.fresh)}`
    if (snap.reuse != null) text += ` · reuse ${Math.round(snap.reuse)}%`
    if (snap.epoch != null) text += ` · e${snap.epoch}`
  }
  return text
}

export function parseSessionListForManthan(sessions: unknown): ManthanContextSnap | null {
  if (!Array.isArray(sessions) || sessions.length === 0) return null
  const sorted = [...sessions].sort(
    (a, b) =>
      ((b as { time?: { updated?: number } }).time?.updated ?? 0) -
      ((a as { time?: { updated?: number } }).time?.updated ?? 0),
  )
  for (const s of sorted) {
    const m = (s as { metadata?: Record<string, unknown> }).metadata?.manthan as
      | Record<string, unknown>
      | undefined
    if (!m) continue
    return {
      used: typeof m.context_used === "number" ? m.context_used : null,
      percent: typeof m.context_usage_percent === "number" ? m.context_usage_percent : null,
      status: typeof m.compaction_status === "string" ? m.compaction_status : null,
      fresh: typeof m.newly_evaluated_tokens === "number" ? m.newly_evaluated_tokens : null,
      reuse: typeof m.cache_reuse_percent === "number" ? m.cache_reuse_percent : null,
      epoch: typeof m.cache_epoch === "number" ? m.cache_epoch : null,
    }
  }
  return null
}
