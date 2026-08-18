/** Shell command: fork binary + port, optionally pinned to a workspace folder. */
export function manthanCliCommand(binary: string, port: number, directory?: string): string {
  const bin = binary.includes(" ") ? `"${binary}"` : binary
  if (!directory) return `${bin} --port ${port}`
  return `${bin} --port ${port} ${JSON.stringify(directory)}`
}

export type ManthanSettings = {
  baseUrl: string
  apiKey: string
  /** Optional preferred model; omit / empty so OpenCode picker is not locked. */
  model: string
  binary: string
  showPowerFields: boolean
  /** Open VS Code tabs when Manthan creates/edits files (SSE `file.edited` / tool parts). */
  openFilesOnEdit: boolean
  /** Auto-close tabs we opened after the edit settles (skipped if dirty / pre-existing). */
  autoCloseEditedFiles: boolean
  /** Edit-range highlight hold ms (0 = off). */
  editHighlightMs: number
  /** When true, open-on-edit steals editor focus from the terminal. */
  openOnEditStealFocus: boolean
}

/** Build OPENCODE_CONFIG_CONTENT JSON for Option A Manthan profile. */
export function buildManthanConfigContent(settings: ManthanSettings): string {
  const headers: Record<string, string> = {
    "X-Manthan-Client": "opencode",
    "X-Manthan-Reasoning-Effort": "medium",
    "X-Title": "Manthan",
    "HTTP-Referer": "https://manthan.ai",
  }
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`
    headers["x-api-key"] = settings.apiKey
  }
  const modelId = settings.model.replace(/^manthan\//, "").trim()
  const models =
    modelId.length > 0
      ? {
          [modelId]: {
            name: settings.model,
            tool_call: true,
            reasoning: true,
            interleaved: { field: "reasoning_content" },
            limit: { context: 65536, output: 4096 },
            options: { reasoningEffort: "medium" },
            variants: {
              none: { reasoningEffort: "none" },
              low: { reasoningEffort: "low" },
              medium: { reasoningEffort: "medium" },
              high: { reasoningEffort: "high" },
            },
          },
        }
      : {}
  const agentEffort = {
    variant: "medium",
    options: { reasoningEffort: "medium" },
  }
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    compaction: {
      auto: false,
      prune: false,
    },
    agent: {
      build: { ...agentEffort },
      plan: { ...agentEffort },
      code: { ...agentEffort },
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
        models,
      },
    },
  }
  // Only pin when the caller explicitly set a model; otherwise OpenCode lists
  // provider.models + live GET /v1/models and the user picks via /models.
  if (settings.model.trim()) {
    config.model = settings.model.trim()
  }
  return JSON.stringify(config)
}

export type ManthanContextSnap = {
  used: number | null
  limit: number | null
  percent: number | null
  compactAt: number | null
  status: string | null
  fresh: number | null
  reuse: number | null
  epoch: number | null
}

export function formatStatusBar(snap: ManthanContextSnap, power: boolean): string {
  const pct = snap.percent != null ? `${Math.round(snap.percent)}%` : "?"
  const used = snap.used != null ? Math.round(snap.used).toLocaleString("en-US") : "?"
  const limit = snap.limit != null && snap.limit > 0 ? Math.round(snap.limit).toLocaleString("en-US") : null
  let text = limit ? `Manthan ${used} / ${limit} (${pct})` : `Manthan ${used} (${pct})`
  if (snap.compactAt != null) text += ` · compact@${Math.round(snap.compactAt)}%`
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
      limit: typeof m.context_limit === "number" ? m.context_limit : null,
      percent: typeof m.context_usage_percent === "number" ? m.context_usage_percent : null,
      compactAt: typeof m.compaction_threshold === "number" ? m.compaction_threshold : null,
      status: typeof m.compaction_status === "string" ? m.compaction_status : null,
      fresh: typeof m.newly_evaluated_tokens === "number" ? m.newly_evaluated_tokens : null,
      reuse: typeof m.cache_reuse_percent === "number" ? m.cache_reuse_percent : null,
      epoch: typeof m.cache_epoch === "number" ? m.cache_epoch : null,
    }
  }
  return null
}
