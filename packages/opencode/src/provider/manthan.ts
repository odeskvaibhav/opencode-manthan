/**
 * Manthan Option A — Manthan owns model-facing context.
 * OpenCode must not auto-compact / LLM-summarize against Manthan.
 *
 * @see infer-pool/docs/opencode-manthan-first-class-plan.md
 */

export type ManthanConfigSlice = {
  model?: string
  provider?: Record<
    string,
    {
      name?: string
      options?: {
        baseURL?: string
        headers?: Record<string, string>
      }
    }
  >
  compaction?: {
    auto?: boolean
    prune?: boolean
    reserved?: number
    tail_turns?: number
    preserve_recent_tokens?: number
  }
}

const MANTHAN_HEADER = "x-manthan-client"

function headerLookup(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v
  }
  return undefined
}

/** Provider id or model string looks like Manthan. */
export function isManthanProviderID(id: string | undefined | null): boolean {
  if (!id) return false
  const s = id.toLowerCase()
  return s === "manthan" || s.startsWith("manthan/") || /(^|\/)manthan(\/|$)/.test(s)
}

export function normalizeManthanModelId(id: string): string {
  return id.trim().replace(/^manthan\//i, "").toLowerCase()
}

/**
 * Internal compact/helper ids — never show in OpenCode model picker.
 * Matches Manthan API `isSidecarPickerModelId` (SIDECAR_MODEL + *-sidecar).
 */
export function isManthanInternalSidecarModelId(id: string): boolean {
  const n = normalizeManthanModelId(id)
  if (!n) return false
  if (n === "sidecar" || n.endsWith("-sidecar")) return true
  // Default SIDECAR_MODEL — keep in sync with infer-pool apps/api sidecar config.
  if (n === "qwen3.5-4b" || n === "qwen3.5-4b-sidecar") return true
  return false
}

export type ManthanModelPolicy = {
  context_limit: number
  compaction_threshold: number | null
}

/** One row from Manthan GET /v1/models (id + context policy). */
export type ManthanModelCatalogEntry = ManthanModelPolicy & {
  id: string
  name?: string
  output_limit?: number
  /** READY workers for this id (0 = loading / stub). */
  workers?: number
}

type ManthanModelPatch = {
  id?: string
  name?: string
  providerID?: string
  api?: { id?: string; url?: string; npm?: string }
  status?: string
  headers?: Record<string, string>
  options?: Record<string, unknown>
  cost?: { input: number; output: number; cache: { read: number; write: number } }
  limit: { context: number; output?: number }
  capabilities?: {
    temperature: boolean
    reasoning: boolean
    attachment: boolean
    toolcall: boolean
    input: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
    output: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
    interleaved: boolean | { field: string }
  }
  family?: string
  release_date?: string
  variants?: Record<string, unknown>
}

export type ManthanGpuReady = {
  status: "ready" | "waking" | "queued" | "capped"
  ready: boolean
  phase?: string
  phaseInstance?: string | null
  lastError?: { message: string } | null
}

export function gpuWakeLabel(status: string | undefined): string {
  if (!status || status === "ready") return ""
  if (status === "capped") return "GPU cap reached — queued"
  if (status === "queued") return "Queued for GPU…"
  return "Waking GPU…"
}

export function gpuWakePhaseLabel(input: {
  status?: string
  phase?: string | null
  phaseInstance?: string | null
  lastError?: { message?: string } | null
}): string {
  const name = input.phaseInstance?.trim()
  const suffix = name ? ` (${name})` : ""
  const phase = (input.phase || "").toLowerCase()
  if (phase === "ready" || input.status === "ready") return ""
  // Phase wins: status can still say capped while a VM is provisioning.
  if (phase === "provisioning") return `Creating GPU VM…${suffix}`
  if (phase === "booting") return `GPU VM booting…${suffix}`
  if (phase === "agent") return `Loading model on GPU…${suffix}`
  if (phase === "error") {
    const msg = input.lastError?.message?.trim()
    return msg ? `GPU error: ${msg.slice(0, 80)}` : "GPU error — check Fleet"
  }
  if (phase === "capped" || input.status === "capped") return "GPU cap reached — queued"
  if (phase === "queued" || input.status === "queued") return "Queued for GPU…"
  return name ? `Waking GPU…${suffix}` : "Waking GPU…"
}

export async function postManthanEnsureReady(input: {
  baseURL: string
  headers: Record<string, string>
  reason: "launch" | "heartbeat" | "chat"
  timeoutMs?: number
}): Promise<ManthanGpuReady | "unauthorized" | "retry"> {
  const base = input.baseURL.replace(/\/+$/, "")
  try {
    const res = await fetch(`${base}/workers/ensure-ready`, {
      method: "POST",
      headers: { ...input.headers, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ reason: input.reason }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 8000),
    })
    if (res.status === 401 || res.status === 403) return "unauthorized"
    if (!res.ok) return "retry"
    const body = (await res.json()) as ManthanGpuReady
    return {
      status: body.status || (body.ready ? "ready" : "waking"),
      ready: body.ready === true,
      phase: body.phase,
      phaseInstance: body.phaseInstance ?? null,
      lastError: body.lastError ?? null,
    }
  } catch {
    return "retry"
  }
}

let gpuHeartbeat: ReturnType<typeof setInterval> | null = null

export function startManthanGpuHeartbeat(input: {
  baseURL: string
  headers: Record<string, string>
  intervalMs?: number
}): void {
  if (gpuHeartbeat) return
  const ms = input.intervalMs ?? 30_000
  gpuHeartbeat = setInterval(() => {
    void postManthanEnsureReady({ ...input, reason: "heartbeat", timeoutMs: 5000 })
  }, ms)
  if (typeof gpuHeartbeat === "object" && gpuHeartbeat && "unref" in gpuHeartbeat) {
    gpuHeartbeat.unref()
  }
}

export function stopManthanGpuHeartbeat(): void {
  if (gpuHeartbeat) clearInterval(gpuHeartbeat)
  gpuHeartbeat = null
}

/** Member-key path: wake org G4 then wait until READY (or cap/timeout). */
export async function waitForManthanGpu(input: {
  baseURL: string
  headers: Record<string, string>
  timeoutMs?: number
  onStatus?: (s: ManthanGpuReady) => void
}): Promise<ManthanGpuReady | null> {
  const deadline = Date.now() + (input.timeoutMs ?? 12 * 60_000)
  let first = true
  while (Date.now() < deadline) {
    const snap = await postManthanEnsureReady({
      ...input,
      reason: first ? "launch" : "heartbeat",
    })
    first = false
    if (snap === "unauthorized") return null
    if (snap === "retry") {
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }
    input.onStatus?.(snap)
    if (snap.ready || snap.status === "ready") return snap
    const wakePhases = new Set(["provisioning", "booting", "agent", "waking"])
    if (
      (snap.status === "capped" || snap.phase === "capped") &&
      !wakePhases.has(String(snap.phase || ""))
    ) {
      return snap
    }
    const line = gpuWakePhaseLabel(snap)
    if (line) {
      try {
        process.stderr.write(`\r${line}   `)
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return { status: "queued", ready: false }
}

/**
 * Read live selectable models from Manthan GET /v1/models.
 * Returns `null` when the request fails (caller keeps static config).
 * On success, **available** rows (excludes sidecar + capability stubs).
 * Org allowlist ids are included even when workers=0 (picker before GPU READY).
 */
export async function fetchManthanModelCatalog(input: {
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  timeoutMs?: number
}): Promise<Map<string, ManthanModelCatalogEntry> | null> {
  const out = new Map<string, ManthanModelCatalogEntry>()
  const base = input.baseURL.replace(/\/+$/, "")
  if (!base) return null
  const headers: Record<string, string> = { Accept: "application/json", ...(input.headers ?? {}) }
  if (input.apiKey && !headerLookup(headers, "authorization")) {
    headers.Authorization = `Bearer ${input.apiKey}`
  }
  const res = await fetch(`${base}/models`, {
    headers,
    signal: AbortSignal.timeout(input.timeoutMs ?? 4000),
  })
  if (!res.ok) return null
  const body = (await res.json()) as { data?: unknown[]; models?: unknown[] }
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const r = row as Record<string, unknown>
    const id = typeof r.id === "string" ? r.id.trim() : ""
    if (!id) continue
    if (isManthanInternalSidecarModelId(id)) continue
    // API lists capability-gated presets with available:false + reason.
    if (r.available === false) continue
    const workers = Number(r.workers)
    const context_limit = Number(r.context_length ?? r.context_window ?? 0)
    const compaction_threshold = Number(r.compaction_threshold)
    const output_limit = Number(r.max_tokens)
    const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : undefined
    out.set(normalizeManthanModelId(id), {
      id,
      name,
      workers: Number.isFinite(workers) ? workers : undefined,
      context_limit: Number.isFinite(context_limit) && context_limit > 0 ? context_limit : 0,
      compaction_threshold:
        Number.isFinite(compaction_threshold) && compaction_threshold > 0 ? compaction_threshold : null,
      output_limit: Number.isFinite(output_limit) && output_limit > 0 ? output_limit : undefined,
    })
  }
  return out
}

/** @deprecated Prefer fetchManthanModelCatalog — kept for callers that only need policies. */
export async function fetchManthanModelPolicies(input: {
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  timeoutMs?: number
}): Promise<Map<string, ManthanModelPolicy>> {
  const catalog = await fetchManthanModelCatalog(input)
  const out = new Map<string, ManthanModelPolicy>()
  if (!catalog) return out
  for (const [key, entry] of catalog) {
    out.set(key, {
      context_limit: entry.context_limit,
      compaction_threshold: entry.compaction_threshold,
    })
  }
  return out
}

export function applyManthanModelPolicies(
  models: Record<string, ManthanModelPatch>,
  policies: Map<string, Pick<ManthanModelPolicy, "context_limit" | "compaction_threshold">>,
): number {
  let n = 0
  for (const [id, model] of Object.entries(models)) {
    const p =
      policies.get(normalizeManthanModelId(id)) ||
      (model.api?.id ? policies.get(normalizeManthanModelId(model.api.id)) : undefined) ||
      (model.id ? policies.get(normalizeManthanModelId(model.id)) : undefined)
    if (!p) continue
    if (p.context_limit > 0) {
      model.limit.context = p.context_limit
      n++
    }
    if (p.compaction_threshold != null) {
      model.options = { ...(model.options ?? {}), compaction_threshold: p.compaction_threshold }
    }
  }
  return n
}

/**
 * OpenCode effort chip (none/low/medium/high) for Manthan models.
 * Live catalog inject used to set `variants: {}`, which hides the chip.
 */
export function manthanReasoningVariants(): Record<string, Record<string, unknown>> {
  const efforts = ["none", "low", "medium", "high"] as const
  return Object.fromEntries(
    efforts.map((effort) => [
      effort,
      {
        reasoningEffort: effort,
        reasoning_effort: effort,
        body: { reasoning_effort: effort },
        headers: { "X-Manthan-Reasoning-Effort": effort },
        options: {
          reasoningEffort: effort,
          headers: { "X-Manthan-Reasoning-Effort": effort },
        },
      },
    ]),
  )
}

function modelWantsManthanEffortVariants(model: ManthanModelPatch): boolean {
  if (model.capabilities?.reasoning === true) return true
  if (model.capabilities?.reasoning === false) return false
  const id = `${model.id ?? ""} ${model.api?.id ?? ""}`
  return /laguna|north|qwen3\.(5|6)|qwen3-next.*thinking|gemma-4|devstral-small-2507|puzzle|gpt-oss/i.test(
    id,
  )
}

/** Fill empty `variants` so the thinking-budget chip appears for reasoning models. */
export function ensureManthanReasoningVariants(
  models: Record<string, ManthanModelPatch>,
): number {
  const defaults = manthanReasoningVariants()
  let n = 0
  for (const [id, model] of Object.entries(models)) {
    if (isManthanInternalSidecarModelId(id) || (model.id && isManthanInternalSidecarModelId(model.id))) {
      continue
    }
    if (!modelWantsManthanEffortVariants(model)) continue
    if (model.variants && Object.keys(model.variants).length > 0) continue
    model.variants = { ...defaults }
    n++
  }
  return n
}

/**
 * OpenCode only paints grey Thought when the model is marked interleaved on
 * `reasoning_content`. Live catalog models and thin static stubs can miss it —
 * CoT then lands in white answer text (VS Code TUI).
 */
export function ensureManthanInterleavedReasoning(
  models: Record<string, ManthanModelPatch>,
): number {
  const field = { field: "reasoning_content" as const }
  let n = 0
  for (const [id, model] of Object.entries(models)) {
    if (isManthanInternalSidecarModelId(id) || (model.id && isManthanInternalSidecarModelId(model.id))) {
      continue
    }
    if (!modelWantsManthanEffortVariants(model) && model.capabilities?.reasoning !== true) {
      continue
    }
    const caps = model.capabilities
    const inter = caps?.interleaved
    const hasField =
      typeof inter === "object" && !!inter && inter.field === "reasoning_content"
    if (caps?.reasoning === true && hasField) continue
    model.capabilities = {
      temperature: caps?.temperature ?? true,
      reasoning: true,
      attachment: caps?.attachment ?? false,
      toolcall: caps?.toolcall ?? true,
      input: caps?.input ?? { text: true, audio: false, image: false, video: false, pdf: false },
      output: caps?.output ?? { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: field,
    }
    n++
  }
  return n
}

export type ManthanThinkEmit = { reasoning?: string; content?: string }

/**
 * Live split for Qwen3-Thinking content leaks (`</think>` closer-only).
 * Agent should already route these to reasoning_content; this is defense-in-depth
 * so OpenCode never paints think body as the assistant answer.
 */
export function scrubManthanPostThinkContent(text: string): string {
  if (!text) return ""
  let c = text
  c = c.replace(/^\s*[a-z]{1,4}\.\s*/u, "")
  c = c.replace(/^\s*[a-z]{1,4}(?=\s*[\n\r])/u, "")
  c = c.replace(/^[\n\r]+/, "")
  return c
}

export function createManthanThinkContentGate(opts?: { assumeThinking?: boolean }) {
  const CLOSE = "</think>"
  const OPEN = "<think>"
  let inThink = opts?.assumeThinking === true
  let carry = ""
  let scrubNextContent = false

  const stripTags = (text: string) => text.replace(/<\/?think>/gi, "")

  const endsWithPrefix = (s: string, needle: string): number => {
    const lower = s.toLowerCase()
    const n = needle.toLowerCase()
    for (let len = Math.min(lower.length, n.length - 1); len >= 1; len--) {
      if (n.startsWith(lower.slice(-len))) return len
    }
    return 0
  }

  const pushEmit = (out: ManthanThinkEmit[], kind: "reasoning" | "content", text: string) => {
    if (!text) return
    let t = text
    if (kind === "content" && scrubNextContent) {
      t = scrubManthanPostThinkContent(t)
      if (!t) return
      scrubNextContent = false
    }
    const last = out[out.length - 1]
    if (last && last[kind] != null && Object.keys(last).length === 1) {
      last[kind] += t
      return
    }
    out.push(kind === "reasoning" ? { reasoning: t } : { content: t })
  }

  return {
    noteUpstreamReasoning() {
      inThink = false
    },
    push(raw: string): ManthanThinkEmit[] {
      if (!raw) return []
      const out: ManthanThinkEmit[] = []
      let s = carry + raw
      carry = ""
      while (s.length > 0) {
        if (inThink) {
          const idx = s.toLowerCase().indexOf(CLOSE.toLowerCase())
          if (idx >= 0) {
            pushEmit(out, "reasoning", s.slice(0, idx))
            s = s.slice(idx + CLOSE.length)
            inThink = false
            scrubNextContent = true
            s = scrubManthanPostThinkContent(s)
            continue
          }
          const hold = endsWithPrefix(s, CLOSE)
          if (hold > 0) {
            pushEmit(out, "reasoning", s.slice(0, -hold))
            carry = s.slice(-hold)
            break
          }
          pushEmit(out, "reasoning", s)
          s = ""
          continue
        }
        const openIdx = s.toLowerCase().indexOf(OPEN.toLowerCase())
        const closeIdx = s.toLowerCase().indexOf(CLOSE.toLowerCase())
        if (openIdx >= 0 && (closeIdx < 0 || openIdx < closeIdx)) {
          pushEmit(out, "content", stripTags(s.slice(0, openIdx)))
          s = s.slice(openIdx + OPEN.length)
          inThink = true
          continue
        }
        if (closeIdx >= 0) {
          pushEmit(out, "reasoning", s.slice(0, closeIdx))
          s = s.slice(closeIdx + CLOSE.length)
          inThink = false
          scrubNextContent = true
          s = scrubManthanPostThinkContent(s)
          continue
        }
        const hold = Math.max(endsWithPrefix(s, OPEN), endsWithPrefix(s, CLOSE))
        if (hold > 0) {
          pushEmit(out, "content", stripTags(s.slice(0, -hold)))
          carry = s.slice(-hold)
          break
        }
        pushEmit(out, "content", stripTags(s))
        s = ""
      }
      return out
    },
    flush(): ManthanThinkEmit[] {
      if (!carry) return []
      const held = carry
      carry = ""
      return this.push(held)
    },
  }
}

/** One-shot salvage for complete assistant text (Qwen closer-only or paired tags). */
export function extractManthanThinkLeak(text: string): { reasoning: string; content: string } {
  if (!text) return { reasoning: "", content: "" }
  const parts: string[] = []
  let content = text
    .replace(/Thinking budget reached\s*[—\-]\s*answering now\.?\s*/gi, "")
    .replace(/<think>([\s\S]*?)<\/think>/gi, (_m, body: string) => {
      const t = String(body || "").trim()
      if (t) parts.push(t)
      return ""
    })
  if (parts.length === 0) {
    let last = -1
    const re = /<\/think>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) last = m.index
    if (last >= 0) {
      const before = content.slice(0, last).trim()
      const after = content.slice(last).replace(/<\/think>/i, "")
      if (before) parts.push(before)
      content = after
    }
  }
  content = content.replace(/<\/?think>/gi, "").replace(/^\s+/, "")
  return {
    reasoning: parts.join("\n\n").trim(),
    content: scrubManthanPostThinkContent(content),
  }
}

/**
 * Add any live /v1/models ids missing from the provider catalog so the OpenCode
 * model picker lists every READY Manthan pool model (not only static config).
 * Does not overwrite existing config entries.
 */
export function ensureManthanModelsFromCatalog(
  models: Record<string, ManthanModelPatch>,
  catalog: Map<string, ManthanModelCatalogEntry>,
  meta: { providerID: string; npm: string; url: string },
): number {
  let added = 0
  const known = new Set<string>()
  for (const [id, model] of Object.entries(models)) {
    known.add(normalizeManthanModelId(id))
    if (model.api?.id) known.add(normalizeManthanModelId(model.api.id))
    if (model.id) known.add(normalizeManthanModelId(model.id))
  }
  const effortVariants = manthanReasoningVariants()
  for (const [key, entry] of catalog) {
    if (isManthanInternalSidecarModelId(entry.id) || isManthanInternalSidecarModelId(key)) continue
    if (known.has(key)) continue
    const id = entry.id
    models[id] = {
      id,
      providerID: meta.providerID,
      name: entry.name ?? id,
      api: { id, url: meta.url, npm: meta.npm },
      status: "active",
      headers: {},
      options:
        entry.compaction_threshold != null ? { compaction_threshold: entry.compaction_threshold } : {},
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: {
        context: entry.context_limit > 0 ? entry.context_limit : 65536,
        output: entry.output_limit ?? 4096,
      },
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: { field: "reasoning_content" },
      },
      family: "",
      release_date: "",
      variants: { ...effortVariants },
    }
    known.add(key)
    added++
  }
  return added
}

function modelMatchesManthanCatalog(
  id: string,
  model: ManthanModelPatch | undefined,
  catalog: Map<string, ManthanModelCatalogEntry>,
): boolean {
  const keys = [
    normalizeManthanModelId(id),
    model?.id ? normalizeManthanModelId(model.id) : "",
    model?.api?.id ? normalizeManthanModelId(model.api.id) : "",
  ].filter(Boolean)
  return keys.some((k) => catalog.has(k))
}

/**
 * After a successful live catalog fetch: drop static config stubs that are not
 * currently online (Gemma/Qwen/etc. presets with no READY workers).
 */
export function pruneManthanModelsToLiveCatalog(
  models: Record<string, ManthanModelPatch>,
  catalog: Map<string, ManthanModelCatalogEntry>,
): number {
  let n = 0
  for (const id of Object.keys(models)) {
    if (modelMatchesManthanCatalog(id, models[id], catalog)) continue
    delete models[id]
    n++
  }
  return n
}

/** Drop sidecar/helper ids that may still be present in static provider config. */
export function pruneManthanSidecarModels(models: Record<string, ManthanModelPatch>): number {
  let n = 0
  for (const id of Object.keys(models)) {
    const model = models[id]
    if (
      isManthanInternalSidecarModelId(id) ||
      (model?.id && isManthanInternalSidecarModelId(model.id)) ||
      (model?.api?.id && isManthanInternalSidecarModelId(model.api.id))
    ) {
      delete models[id]
      n++
    }
  }
  return n
}

/** Config selects Manthan as the active / configured backend. */
export function isManthanConfig(cfg: ManthanConfigSlice): boolean {
  if (process.env.OPENCODE_MANTHAN_MODE === "1" || process.env.OPENCODE_MANTHAN_MODE === "true") {
    return true
  }
  if (isManthanProviderID(cfg.model)) return true
  const providers = cfg.provider ?? {}
  for (const [id, info] of Object.entries(providers)) {
    if (isManthanProviderID(id)) return true
    if (isManthanProviderID(info?.name)) return true
    if (headerLookup(info?.options?.headers, MANTHAN_HEADER)) return true
  }
  return false
}

/**
 * Option A defaults: disable OpenCode auto-compact + prune.
 * Escape hatch: OPENCODE_MANTHAN_ALLOW_CLIENT_COMPACT=1
 */
export function applyManthanOptionA(cfg: ManthanConfigSlice): ManthanConfigSlice {
  if (!isManthanConfig(cfg)) return cfg
  if (
    process.env.OPENCODE_MANTHAN_ALLOW_CLIENT_COMPACT === "1" ||
    process.env.OPENCODE_MANTHAN_ALLOW_CLIENT_COMPACT === "true"
  ) {
    return cfg
  }
  return {
    ...cfg,
    compaction: {
      ...cfg.compaction,
      auto: false,
      prune: false,
    },
  }
}

/** Ensure identity header is present for Manthan requests. */
export function ensureManthanClientHeaders(
  headers: Record<string, string> | undefined,
  providerID: string,
): Record<string, string> {
  const out = { ...(headers ?? {}) }
  if (!isManthanProviderID(providerID) && !headerLookup(out, MANTHAN_HEADER)) {
    return out
  }
  if (!headerLookup(out, MANTHAN_HEADER)) {
    out["x-manthan-client"] = "opencode"
  }
  return out
}

function asReasoningEffort(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  const s = v.trim().toLowerCase()
  if (!s || s === "default") return undefined
  return s
}

/**
 * Resolve Laguna/Manthan reasoning effort for a request.
 * Product default is `medium`. Prefer explicit UI/agent/variant controls over
 * static model `options.reasoningEffort` stubs (often leftover `"none"`/`"low"`).
 */
export function manthanReasoningEffort(input: {
  userVariant?: string
  agent?: { variant?: string; options?: Record<string, any> }
  options?: Record<string, any>
  variant?: Record<string, any>
}): string {
  const header =
    input.options?.headers?.["X-Manthan-Reasoning-Effort"] ??
    input.options?.headers?.["x-manthan-reasoning-effort"] ??
    input.variant?.headers?.["X-Manthan-Reasoning-Effort"] ??
    input.variant?.headers?.["x-manthan-reasoning-effort"]
  const candidates = [
    input.userVariant,
    input.agent?.variant,
    input.agent?.options?.reasoningEffort,
    input.agent?.options?.reasoning_effort,
    input.variant?.reasoning_effort,
    input.variant?.reasoningEffort,
    header,
  ]
  for (const c of candidates) {
    const effort = asReasoningEffort(c)
    if (effort) return effort
  }
  return "medium"
}

/** Session affinity headers Manthan already understands. */
export function manthanSessionHeaders(sessionID: string): Record<string, string> {
  return {
    "x-manthan-client": "opencode",
    "x-opencode-session": sessionID,
    "x-opencode-session-id": sessionID,
    "x-session-affinity": sessionID,
    "X-Session-Id": sessionID,
    "X-Title": "Manthan",
    "HTTP-Referer": "https://manthan.ai",
    // Prefill % arrives as SSE comments (safe for OpenCode Zod).
    "x-manthan-progress": "comment",
  }
}

/** Live llama prefill progress for New Chat warmup UI. */
export type ManthanPromptProgress = {
  sessionID: string
  percent: number | null
  prompt_tokens: number | null
  prompt_tokens_processed: number | null
  prompt_tokens_cached: number | null
  stage: string | null
  message: string | null
  updated_at: number
}

const promptProgressBySession = new Map<string, ManthanPromptProgress>()
const promptProgressListeners = new Set<(p: ManthanPromptProgress) => void>()

function isLikelyLlamaBatchSize(n: number): boolean {
  return n > 0 && n <= 65_536 && (n % 2048 === 0 || n % 1024 === 0)
}

export function isManthanPrefillStage(stage: string | null | undefined): boolean {
  if (!stage) return true
  return stage === "prompt_eval" || stage === "model_loading" || stage === "queue" || stage === "routing"
}

/**
 * llama /slots often reports the current n_batch chunk as both processed and
 * total (2048/2048 → 4096/4096). Drop the fake denominator until processed < total.
 * Compaction/generation payloads must not clobber prefill % or token counts.
 */
export function normalizeManthanPrefillProgress(
  next: ManthanPromptProgress,
  prev?: ManthanPromptProgress,
): ManthanPromptProgress {
  if (!isManthanPrefillStage(next.stage) && prev) {
    return {
      ...next,
      prompt_tokens: prev.prompt_tokens,
      prompt_tokens_processed: prev.prompt_tokens_processed,
      prompt_tokens_cached: prev.prompt_tokens_cached,
      percent: prev.percent,
      message: next.message ?? prev.message,
    }
  }

  let processed = next.prompt_tokens_processed
  let total = next.prompt_tokens
  let percent = next.percent

  if (typeof processed === "number" && typeof prev?.prompt_tokens_processed === "number") {
    processed = Math.max(processed, prev.prompt_tokens_processed)
  }

  const complete =
    typeof total === "number" && typeof processed === "number" && total > 0 && processed >= total
  const prevComplete =
    typeof prev?.prompt_tokens === "number" &&
    typeof prev.prompt_tokens_processed === "number" &&
    prev.prompt_tokens > 0 &&
    prev.prompt_tokens_processed >= prev.prompt_tokens
  const totalGrewComplete =
    complete && prevComplete && typeof prev?.prompt_tokens === "number" && total! > prev.prompt_tokens

  if (complete && (totalGrewComplete || isLikelyLlamaBatchSize(total!))) {
    processed = Math.max(processed ?? 0, total ?? 0)
    total = null
    percent = null
  } else if (typeof total === "number" && typeof processed === "number" && total > processed && total > 0) {
    percent = Math.max(0, Math.min(99, Math.round((100 * processed) / total)))
  } else if (typeof percent === "number") {
    percent = Math.max(0, Math.min(99, Math.round(percent)))
  }

  const message = next.message ?? prev?.message ?? null

  return {
    ...next,
    prompt_tokens: total,
    prompt_tokens_processed: processed,
    percent,
    message,
  }
}

export function rememberManthanPromptProgress(progress: ManthanPromptProgress): void {
  const normalized = normalizeManthanPrefillProgress(progress, promptProgressBySession.get(progress.sessionID))
  promptProgressBySession.set(progress.sessionID, normalized)
  for (const fn of promptProgressListeners) {
    try {
      fn(normalized)
    } catch {
      // ignore
    }
  }
  // Fan out to the desktop/web event stream (New Chat warmup listens).
  void import("@/bus/global")
    .then(({ GlobalBus }) => {
      GlobalBus.emit("event", {
        payload: {
          type: "manthan.prompt_progress",
          properties: normalized,
        },
      })
    })
    .catch(() => {})
}

export function peekManthanPromptProgress(sessionID: string): ManthanPromptProgress | undefined {
  return promptProgressBySession.get(sessionID)
}

export function subscribeManthanPromptProgress(fn: (p: ManthanPromptProgress) => void): () => void {
  promptProgressListeners.add(fn)
  return () => {
    promptProgressListeners.delete(fn)
  }
}

/** Clear prompt-progress store (tests). */
export function clearManthanPromptProgressStore(): void {
  promptProgressBySession.clear()
}

/** Parse complete `manthan-progress` SSE comment blocks from a text buffer. */
export function ingestManthanProgressSseComments(sessionID: string, text: string): string {
  if (!sessionID || !text) return text
  // Keep a trailing partial block; comments end with blank line.
  const parts = text.split(/\n\n/)
  const incomplete = text.endsWith("\n\n") ? "" : (parts.pop() ?? "")
  for (const block of parts) {
    const line = block
      .split("\n")
      .map((l) => l.trimEnd())
      .find((l) => l.startsWith(":") && l.includes("manthan-progress"))
    if (!line) continue
    const jsonStart = line.indexOf("{")
    if (jsonStart < 0) continue
    try {
      const payload = JSON.parse(line.slice(jsonStart)) as {
        object?: string
        stage?: string
        message?: string
        percent?: number
        prompt_tokens?: number
        prompt_tokens_processed?: number
        prompt_tokens_cached?: number
      }
      if (payload.object !== "manthan.progress") continue
      rememberManthanPromptProgress({
        sessionID,
        percent: typeof payload.percent === "number" ? payload.percent : null,
        prompt_tokens: typeof payload.prompt_tokens === "number" ? payload.prompt_tokens : null,
        prompt_tokens_processed:
          typeof payload.prompt_tokens_processed === "number" ? payload.prompt_tokens_processed : null,
        prompt_tokens_cached:
          typeof payload.prompt_tokens_cached === "number" ? payload.prompt_tokens_cached : null,
        stage: typeof payload.stage === "string" ? payload.stage : null,
        message: typeof payload.message === "string" ? payload.message : null,
        updated_at: Date.now(),
      })
    } catch {
      // ignore partial / bad JSON
    }
  }
  return incomplete
}

/** Tee an SSE Response so we can scrape prefill progress comments. */
export function teeManthanProgressResponse(res: Response, sessionID: string | undefined): Response {
  if (!sessionID || !res.body) return res
  const ct = res.headers.get("content-type") || ""
  if (!ct.includes("text/event-stream")) return res
  const [forClient, forProbe] = res.body.tee()
  void (async () => {
    const reader = forProbe.getReader()
    const decoder = new TextDecoder()
    let carry = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        carry += decoder.decode(value, { stream: true })
        carry = ingestManthanProgressSseComments(sessionID, carry)
      }
      carry += decoder.decode()
      ingestManthanProgressSseComments(sessionID, carry.endsWith("\n\n") ? carry : `${carry}\n\n`)
    } catch {
      // ignore — probe stream
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // ignore
      }
    }
  })()
  return new Response(forClient, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

/** `.../v1/chat/completions` → `.../v1/sessions/{id}/progress` */
export function manthanSessionProgressUrl(chatRequestUrl: string | URL, sessionID: string): string | undefined {
  if (!sessionID) return undefined
  try {
    const u = new URL(String(chatRequestUrl))
    const path = u.pathname.replace(/\/+$/, "")
    const v1 = path.lastIndexOf("/v1")
    u.pathname =
      v1 >= 0
        ? `${path.slice(0, v1 + 3)}/sessions/${encodeURIComponent(sessionID)}/progress`
        : `/v1/sessions/${encodeURIComponent(sessionID)}/progress`
    u.search = ""
    u.hash = ""
    return u.toString()
  } catch {
    return undefined
  }
}

/** `.../v1/chat/completions` → `.../v1/sessions/cancel` */
export function manthanSessionCancelUrl(chatRequestUrl: string | URL): string | undefined {
  try {
    const u = new URL(String(chatRequestUrl))
    const path = u.pathname.replace(/\/+$/, "")
    const v1 = path.lastIndexOf("/v1")
    u.pathname = v1 >= 0 ? `${path.slice(0, v1 + 3)}/sessions/cancel` : `/v1/sessions/cancel`
    u.search = ""
    u.hash = ""
    return u.toString()
  } catch {
    return undefined
  }
}

type ManthanCancelTarget = {
  url: string
  headers: Record<string, string>
  chatUrl: string
}

const cancelTargetBySession = new Map<string, ManthanCancelTarget>()

/** Remember how to cancel this session's Manthan job (for Esc when TCP stays up). */
export function rememberManthanCancelTarget(opts: {
  sessionID: string
  chatUrl: string
  headers?: Headers | Record<string, string>
}): void {
  if (!opts.sessionID) return
  const url = manthanSessionCancelUrl(opts.chatUrl)
  if (!url) return
  cancelTargetBySession.set(opts.sessionID, {
    url,
    chatUrl: opts.chatUrl,
    headers: headerRecord(opts.headers),
  })
}

export function clearManthanCancelTarget(sessionID: string): void {
  cancelTargetBySession.delete(sessionID)
}

/**
 * Explicit Manthan cancel — Bun/OpenCode often abort the SSE reader without
 * closing TCP quickly, so the API keeps inferencing until this fires.
 */
export function requestManthanSessionCancel(opts: {
  sessionID: string
  chatUrl?: string
  headers?: Headers | Record<string, string>
}): void {
  const sessionID = opts.sessionID?.trim()
  if (!sessionID) return
  const remembered = cancelTargetBySession.get(sessionID)
  const chatUrl = opts.chatUrl || remembered?.chatUrl
  const url = (chatUrl ? manthanSessionCancelUrl(chatUrl) : undefined) || remembered?.url
  if (!url) return
  const headers: Record<string, string> = {
    ...(remembered?.headers ?? {}),
    ...headerRecord(opts.headers),
    "content-type": "application/json",
    "x-session-id": sessionID,
    "x-opencode-session": sessionID,
    "x-opencode-session-id": sessionID,
  }
  promptProgressBySession.delete(sessionID)
  void fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ session_id: sessionID }),
  }).catch(() => {})
}

function headerRecord(src: Headers | Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!src) return out
  const names = [
    "authorization",
    "x-api-key",
    "x-manthan-client",
    "x-opencode-session",
    "x-opencode-session-id",
    "x-session-affinity",
    "x-session-id",
  ]
  for (const name of names) {
    const v = headerGet(src, name)
    if (v) out[name] = v
  }
  return out
}

/** Poll Manthan `/v1/sessions/:id/progress` for live llama /slots prefill %. */
export function startManthanProgressPoll(opts: {
  sessionID: string
  url: string
  headers?: Headers | Record<string, string>
  signal?: AbortSignal
}): () => void {
  let stopped = false
  const ctrl = new AbortController()
  const onAbort = () => {
    stopped = true
    ctrl.abort()
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true })
  const headers = headerRecord(opts.headers)

  void (async () => {
    while (!stopped && !ctrl.signal.aborted) {
      try {
        const res = await fetch(opts.url, {
          headers,
          signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(2000)]),
        })
        if (res.ok) {
          const j = (await res.json()) as {
            percent?: number | null
            prompt_tokens?: number | null
            prompt_tokens_processed?: number | null
            prompt_tokens_cached?: number | null
            stage?: string | null
          }
          const percent = typeof j.percent === "number" ? j.percent : null
          const total = typeof j.prompt_tokens === "number" ? j.prompt_tokens : null
          const processed = typeof j.prompt_tokens_processed === "number" ? j.prompt_tokens_processed : null
          if (percent != null || (total != null && total > 0 && processed != null) || (processed != null && processed > 0)) {
            rememberManthanPromptProgress({
              sessionID: opts.sessionID,
              percent:
                percent ??
                (total && processed != null && total > processed
                  ? Math.max(0, Math.min(99, Math.round((100 * processed) / total)))
                  : null),
              prompt_tokens: total,
              prompt_tokens_processed: processed,
              prompt_tokens_cached: typeof j.prompt_tokens_cached === "number" ? j.prompt_tokens_cached : null,
              stage: typeof j.stage === "string" ? j.stage : null,
              message: null,
              updated_at: Date.now(),
            })
          }
        }
      } catch {
        // ignore transient poll errors
      }
      await Bun.sleep(400)
    }
  })()

  return () => {
    stopped = true
    ctrl.abort()
    opts.signal?.removeEventListener("abort", onAbort)
  }
}

const pendingCompact = new Set<string>()

/** Queue a one-shot `x-manthan-compact: 1` on the next model request. */
export function requestManthanCompact(sessionID: string): void {
  pendingCompact.add(sessionID)
}

/** Consume pending compact flag (returns true once). */
export function consumeManthanCompact(sessionID: string): boolean {
  if (!pendingCompact.has(sessionID)) return false
  pendingCompact.delete(sessionID)
  return true
}

export function clearManthanCompactQueue(): void {
  pendingCompact.clear()
}

/** Synthetic follow-up after Manthan server compact (mirrors OpenCode autocontinue). */
export const MANTHAN_COMPACT_CONTINUE_TEXT =
  "Context was compacted mid-task. Continue the unfinished work immediately with tools. Do not stop or ask for clarification unless the task is truly blocked — pick up from the recap's pending/next step."

/**
 * After Manthan condenses, the current assistant often finishes with `stop`.
 * Without a new user turn the prompt loop exits and subagents look "stuck".
 * Inject continue when a new compact marker was added and the turn would exit.
 */
export function shouldManthanCompactAutocontinue(input: {
  added: boolean
  finish: string | undefined
  error?: unknown
}): boolean {
  if (!input.added) return false
  if (input.error) return false
  if (!input.finish || ["tool-calls", "unknown"].includes(input.finish)) return false
  return true
}

/** Max synthetic user turns after stop-without-tools on a build/fix task. */
export const MANTHAN_TOOL_AVOIDANCE_CONTINUE_MAX = 2

export const MANTHAN_TOOL_AVOIDANCE_CONTINUE_TEXT =
  "You stopped without calling a tool. The build/fix task is not done. " +
  "Immediately call bash, read, edit, or write — do not explain or plan in prose."

type ManthanMsgWithParts = {
  info: { role: string }
  parts: Array<{
    type: string
    text?: string
    synthetic?: boolean
    tool?: string
    metadata?: Record<string, unknown>
    state?: {
      status: string
      output?: string
      error?: string
      metadata?: Record<string, unknown>
    }
  }>
}

export function manthanToolAvoidanceContinueEnabled(): boolean {
  const v = process.env.OPENCODE_MANTHAN_TOOL_AVOIDANCE_CONTINUE
  if (v === "0" || v === "false") return false
  return true
}

export function userAskLooksLikeBuildFix(text: string): boolean {
  const t = (text || "").replace(/\s+/g, " ").trim()
  if (!t) return false
  return /\b(fix|build|compile|type.?error|tsc|bun run|npm run|pnpm|yarn build|until exit 0|green build)\b/i.test(
    t,
  )
}

function bashToolOutputFailed(tool: string | undefined, state: ManthanMsgWithParts["parts"][0]["state"]): boolean {
  if (!state) return false
  if (state.status === "error") return true
  if (state.status !== "completed") return false
  const output = state.output || ""
  const exit = state.metadata?.exit
  if (typeof exit === "number" && exit !== 0) return true
  if (/\[ERROR\]/i.test(output)) return true
  if (/\berror TS\d+\b/i.test(output)) return true
  if (/\bBuild failed\b/i.test(output)) return true
  if (/\berror during build\b/i.test(output)) return true
  if (/\[UNRESOLVED_IMPORT\]/i.test(output)) return true
  if (/✗/.test(output) && /\bfailed\b/i.test(output)) return true
  if (/failed/i.test(output) && /bash|shell|command/i.test(tool || "")) return true
  return false
}

/** Most recent bash tool in session history failed. */
export function sessionLastBashFailed(msgs: ManthanMsgWithParts[]): boolean {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j]!
      if (p.type !== "tool") continue
      if (!/bash|shell|terminal|run_terminal/i.test(p.tool || "")) continue
      return bashToolOutputFailed(p.tool, p.state)
    }
  }
  return false
}

/** Non-synthetic root user ask (skips compact / avoidance continue messages). */
export function rootUserAskFromMessages(msgs: ManthanMsgWithParts[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!
    if (m.info.role !== "user") continue
    const synthetic = m.parts.some(
      (p) =>
        p.type === "text" &&
        (p.metadata?.tool_avoidance_continue === true ||
          p.metadata?.manthan_compact_continue === true ||
          p.metadata?.compaction_continue === true),
    )
    if (synthetic) continue
    return m.parts
      .filter((p): p is { type: "text"; text: string; synthetic?: boolean } => p.type === "text" && !p.synthetic)
      .map((p) => p.text)
      .join("\n")
      .trim()
  }
  return ""
}

export function countManthanToolAvoidanceContinues(msgs: ManthanMsgWithParts[]): number {
  let count = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!
    if (m.info.role !== "user") continue
    const avoidance = m.parts.some(
      (p) => p.type === "text" && p.metadata?.tool_avoidance_continue === true,
    )
    if (avoidance) count++
    else break
  }
  return count
}

export function manthanToolAvoidanceContinueText(input: {
  bashFailed: boolean
  attempt: number
}): string {
  if (input.bashFailed) {
    if (input.attempt >= 1) {
      return (
        "[MANTHAN] Build is still failing. Run bash to see errors, then edit or write to fix them. " +
        "Call a tool now — no prose."
      )
    }
    return (
      "[MANTHAN] The last bash command failed. Fix the errors with edit/write, then rerun bash. " +
      "Invoke a tool immediately — do not stop."
    )
  }
  if (input.attempt >= 1) {
    return (
      "[MANTHAN] You stopped again without tools. Call bash, read, edit, or write now. " +
      "Do not explain — emit the tool call."
    )
  }
  return MANTHAN_TOOL_AVOIDANCE_CONTINUE_TEXT
}

export function shouldManthanToolAvoidanceAutocontinue(input: {
  providerID: string
  finish: string | undefined
  error?: unknown
  hasToolCalls: boolean
  userAskText: string
  continueCount: number
  bashFailed: boolean
}): boolean {
  if (!manthanToolAvoidanceContinueEnabled()) return false
  if (!isManthanProviderID(input.providerID)) return false
  if (input.error) return false
  if (input.hasToolCalls) return false
  if (!input.finish || ["tool-calls", "unknown"].includes(input.finish)) return false
  if (!["stop", "length"].includes(input.finish)) return false
  if (input.continueCount >= MANTHAN_TOOL_AVOIDANCE_CONTINUE_MAX) return false
  if (!userAskLooksLikeBuildFix(input.userAskText) && !input.bashFailed) return false
  return true
}

export function manthanClientCompactAllowed(): boolean {
  return (
    process.env.OPENCODE_MANTHAN_ALLOW_CLIENT_COMPACT === "1" ||
    process.env.OPENCODE_MANTHAN_ALLOW_CLIENT_COMPACT === "true"
  )
}

/** Timeline divider after a real Manthan condense (Cursor-style, not an OpenCode compaction part). */
export type ManthanCompactMarker = {
  messageID: string
  epoch: number
  at: number
  summary?: string
}

export function parseManthanCompactMarkers(raw: unknown): ManthanCompactMarker[] {
  if (!Array.isArray(raw)) return []
  const out: ManthanCompactMarker[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const o = item as Record<string, unknown>
    if (typeof o.messageID !== "string" || !o.messageID) continue
    const summary = typeof o.summary === "string" ? o.summary.trim() : ""
    out.push({
      messageID: o.messageID,
      epoch: typeof o.epoch === "number" && Number.isFinite(o.epoch) ? Math.floor(o.epoch) : 0,
      at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0,
      ...(summary ? { summary } : {}),
    })
  }
  return out
}

/** Append one divider per compact epoch / user turn. */
export function nextManthanCompactMarkers(
  prev: ManthanCompactMarker[] | undefined,
  input: {
    compactionStatus: string | null | undefined
    epoch: number | null | undefined
    messageID: string | null | undefined
    at?: number
    summary?: string | null
    /** Present only when API actually ran server auto-compact this turn. */
    compactReason?: string | null
  },
): { markers: ManthanCompactMarker[]; added: boolean } {
  const markers = [...(prev ?? [])]
  if (input.compactionStatus !== "compacted") {
    return { markers, added: false }
  }
  const summary = input.summary?.trim() || ""
  // Reject false positives: epoch bumps / client rewrites used to set
  // status=compacted with no summary → empty "Earlier chat turns were condensed".
  // Also require a real summary for the divider (reason-alone used to double-paint
  // after OpenCode's compaction seal turn).
  if (!summary) {
    return { markers, added: false }
  }
  const epoch =
    input.epoch != null && Number.isFinite(Number(input.epoch)) ? Math.floor(Number(input.epoch)) : null
  const messageID =
    (typeof input.messageID === "string" && input.messageID.trim()) ||
    `__manthan_orphan_${epoch ?? "x"}`
  if (markers.some((m) => m.messageID === messageID)) {
    return { markers, added: false }
  }
  if (epoch != null && markers.some((m) => m.epoch === epoch)) {
    return { markers, added: false }
  }
  const at = input.at ?? Date.now()
  const last = markers[markers.length - 1]
  // Back-to-back API/client compact echoes within 90s → one UI divider.
  if (last && at - last.at < 90_000) {
    const a = (last.summary || "").slice(0, 120)
    const b = summary.slice(0, 120)
    if (!a || !b || a === b || a.startsWith(b.slice(0, 40)) || b.startsWith(a.slice(0, 40))) {
      return { markers, added: false }
    }
  }
  markers.push({
    messageID,
    epoch: epoch ?? 0,
    at,
    summary,
  })
  return { markers, added: true }
}

/** Authoritative context usage from Manthan response headers (Phase 2). */
export type ManthanContextUsage = {
  context_limit: number | null
  context_used: number | null
  context_usable: number | null
  context_remaining: number | null
  context_usage_percent: number | null
  reserved_tokens: number | null
  compaction_threshold: number | null
  compaction_status: string | null
  cache_epoch: number | null
  cache_reuse_percent: number | null
  newly_evaluated_tokens: number | null
  cache_generation: number | null
  updated_at: number
  compact_summary?: string | null
  compact_markers?: ManthanCompactMarker[]
  compact_reason?: string | null
  compact_usage_before_percent?: number | null
  compact_usage_before_tokens?: number | null
  sidecar_route?: string | null
  compact_route?: string | null
}

const pendingBySession = new Map<string, ManthanContextUsage>()

function headerGet(headers: Headers | Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? (headers as Headers).get(name.toLowerCase()) ?? undefined
  }
  return headerLookup(headers as Record<string, string>, name)
}

export function decodeManthanCompactSummaryHeader(
  headers: Headers | Record<string, string> | undefined,
): string | null {
  const b64 = headerGet(headers, "x-manthan-compact-summary-b64")?.trim()
  if (!b64) return null
  try {
    const text =
      typeof Buffer !== "undefined"
        ? Buffer.from(b64, "base64").toString("utf8")
        : new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
    const cleaned = text.replace(/\[MANTHAN_CONTEXT_COMPACTION\]\s*/g, "").trim()
    return cleaned || null
  } catch {
    return null
  }
}

function numHeader(headers: Headers | Record<string, string> | undefined, name: string): number | null {
  const raw = headerGet(headers, name)
  if (raw == null || raw === "") return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** True if any Manthan context header is present. */
export function hasManthanContextHeaders(headers: Headers | Record<string, string> | undefined): boolean {
  return (
    headerGet(headers, "x-manthan-context-used") != null ||
    headerGet(headers, "x-manthan-context-usage-percent") != null ||
    headerGet(headers, "x-manthan-context-limit") != null
  )
}

export function parseManthanContextHeaders(
  headers: Headers | Record<string, string> | undefined,
): ManthanContextUsage | null {
  if (!hasManthanContextHeaders(headers)) return null
  return {
    context_limit: numHeader(headers, "x-manthan-context-limit"),
    context_used: numHeader(headers, "x-manthan-context-used"),
    context_usable: numHeader(headers, "x-manthan-context-usable"),
    context_remaining: numHeader(headers, "x-manthan-context-remaining"),
    context_usage_percent: numHeader(headers, "x-manthan-context-usage-percent"),
    reserved_tokens: numHeader(headers, "x-manthan-reserved-tokens"),
    compaction_threshold: numHeader(headers, "x-manthan-compaction-threshold"),
    compaction_status: headerGet(headers, "x-manthan-compaction-status") ?? null,
    cache_epoch: numHeader(headers, "x-manthan-cache-epoch"),
    cache_reuse_percent: numHeader(headers, "x-manthan-cache-reuse-percent"),
    newly_evaluated_tokens: numHeader(headers, "x-manthan-newly-evaluated-tokens"),
    cache_generation: numHeader(headers, "x-manthan-cache-generation"),
    updated_at: Date.now(),
    compact_summary: decodeManthanCompactSummaryHeader(headers),
    compact_reason: headerGet(headers, "x-manthan-compact-reason") ?? null,
    compact_usage_before_percent: numHeader(
      headers,
      "x-manthan-compact-usage-before-percent",
    ),
    compact_usage_before_tokens: numHeader(headers, "x-manthan-compact-usage-before-tokens"),
    sidecar_route: headerGet(headers, "x-manthan-sidecar-route") ?? null,
    compact_route: headerGet(headers, "x-manthan-compact-route") ?? null,
  }
}

/** `opencode run --format json` / soak runners (OPENCODE_MANTHAN_MODE=1). */
export function isManthanLaunchMode(): boolean {
  const raw = process.env.OPENCODE_MANTHAN_MODE
  return raw === "1" || raw === "true"
}

/** Payload for JSONL `manthan_compact` events and stderr telemetry. */
export type ManthanCompactJsonl = {
  status: string
  reason: string | null
  context_used_after: number | null
  context_used_before_tokens: number | null
  usage_before_percent: number | null
  sidecar_route: string | null
  compact_route: string | null
  summary_preview: string | null
  message_id?: string
}

export function buildManthanCompactJsonl(
  usage: ManthanContextUsage,
  opts?: { messageID?: string },
): ManthanCompactJsonl | null {
  if (usage.compaction_status !== "compacted") return null
  const summary = usage.compact_summary?.trim() || null
  return {
    status: usage.compaction_status,
    reason: usage.compact_reason ?? null,
    context_used_after: usage.context_used,
    context_used_before_tokens: usage.compact_usage_before_tokens ?? null,
    usage_before_percent: usage.compact_usage_before_percent ?? null,
    sidecar_route: usage.sidecar_route ?? null,
    compact_route: usage.compact_route ?? null,
    summary_preview: summary ? summary.slice(0, 800) : null,
    ...(opts?.messageID ? { message_id: opts.messageID } : {}),
  }
}

export function formatManthanCompactStderrLine(telemetry: ManthanCompactJsonl): string {
  return `[manthan-compact] ${JSON.stringify(telemetry)}`
}

const SESSION_HEADER_KEYS = [
  "x-opencode-session-id",
  "x-opencode-session",
  "x-session-affinity",
  "x-session-id",
] as const

export function sessionIDFromRequestHeaders(
  headers: Headers | Record<string, string> | undefined,
): string | undefined {
  for (const key of SESSION_HEADER_KEYS) {
    const v = headerGet(headers, key)?.trim()
    if (v) return v
  }
  return undefined
}

/** All session ids on a header bag (child + affinity). Never includes x-parent-session-id. */
export function allManthanSessionIDsFromHeaders(
  headers: Headers | Record<string, string> | undefined,
): string[] {
  const ids: string[] = []
  for (const key of SESSION_HEADER_KEYS) {
    const v = headerGet(headers, key)?.trim()
    if (v && !ids.includes(v)) ids.push(v)
  }
  return ids
}

/** AI SDK often puts headers on the Request, not init — also check response echo. */
export function sessionIDFromFetch(input: {
  request?: Request | string | URL
  initHeaders?: Headers | Record<string, string>
  response?: Response | Headers | Record<string, string>
}): string | undefined {
  const resHeaders =
    input.response instanceof Response ? input.response.headers : input.response
  return (
    sessionIDFromRequestHeaders(input.initHeaders) ||
    (input.request instanceof Request ? sessionIDFromRequestHeaders(input.request.headers) : undefined) ||
    sessionIDFromRequestHeaders(resHeaders)
  )
}

/** Stash latest Manthan context for a session (fetch → processor handoff). */
export function rememberManthanContext(
  sessionID: string,
  usage: ManthanContextUsage,
  aliases?: string[],
): void {
  const ids = new Set<string>()
  if (sessionID) ids.add(sessionID)
  for (const id of aliases ?? []) {
    if (id) ids.add(id)
  }
  for (const id of ids) pendingBySession.set(id, usage)
}

/** Read without clearing (TUI / debug). */
export function peekManthanContext(sessionID: string): ManthanContextUsage | undefined {
  return pendingBySession.get(sessionID)
}

/** Take pending context once for persistence onto session.metadata. */
export function takeManthanContext(sessionID: string): ManthanContextUsage | undefined {
  const v = pendingBySession.get(sessionID)
  if (!v) return undefined
  for (const [k, val] of pendingBySession) {
    if (val === v) pendingBySession.delete(k)
  }
  return v
}

/** Clear store (tests). */
export function clearManthanContextStore(): void {
  pendingBySession.clear()
}

export function formatManthanContextLabel(usage: ManthanContextUsage): string | undefined {
  const used = usage.context_used
  const limit = usage.context_limit
  const pct = usage.context_usage_percent
  const compactAt = usage.compaction_threshold
  if (used == null && pct == null && limit == null) return undefined
  const usedLabel = used != null ? Math.round(used).toLocaleString("en-US") : "?"
  const limitLabel = limit != null && limit > 0 ? Math.round(limit).toLocaleString("en-US") : null
  const parts: string[] = []
  if (limitLabel) parts.push(`${usedLabel} / ${limitLabel}`)
  else parts.push(usedLabel)
  if (pct != null) parts.push(`${Math.round(pct)}%`)
  if (compactAt != null && Number.isFinite(compactAt)) parts.push(`compact@${Math.round(compactAt)}%`)
  return parts.join(" · ")
}

export function manthanContextFromMetadata(metadata: Record<string, unknown> | undefined): ManthanContextUsage | null {
  const raw = metadata?.manthan
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  if (o.context_used == null && o.context_usage_percent == null && o.context_limit == null) return null
  return {
    context_limit: typeof o.context_limit === "number" ? o.context_limit : null,
    context_used: typeof o.context_used === "number" ? o.context_used : null,
    context_usable: typeof o.context_usable === "number" ? o.context_usable : null,
    context_remaining: typeof o.context_remaining === "number" ? o.context_remaining : null,
    context_usage_percent: typeof o.context_usage_percent === "number" ? o.context_usage_percent : null,
    reserved_tokens: typeof o.reserved_tokens === "number" ? o.reserved_tokens : null,
    compaction_threshold: typeof o.compaction_threshold === "number" ? o.compaction_threshold : null,
    compaction_status: typeof o.compaction_status === "string" ? o.compaction_status : null,
    cache_epoch: typeof o.cache_epoch === "number" ? o.cache_epoch : null,
    cache_reuse_percent: typeof o.cache_reuse_percent === "number" ? o.cache_reuse_percent : null,
    newly_evaluated_tokens: typeof o.newly_evaluated_tokens === "number" ? o.newly_evaluated_tokens : null,
    cache_generation: typeof o.cache_generation === "number" ? o.cache_generation : null,
    updated_at: typeof o.updated_at === "number" ? o.updated_at : 0,
    compact_summary: typeof o.compact_summary === "string" ? o.compact_summary.trim() || null : null,
    compact_markers: parseManthanCompactMarkers(o.compact_markers),
    compact_reason: typeof o.compact_reason === "string" ? o.compact_reason : null,
    compact_usage_before_percent:
      typeof o.compact_usage_before_percent === "number" && Number.isFinite(o.compact_usage_before_percent)
        ? o.compact_usage_before_percent
        : null,
  }
}
