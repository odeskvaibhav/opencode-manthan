import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Deferred, Effect, Exit, Layer, Context, Scope, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { MessageID, PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { Usage, type LLMEvent } from "@opencode-ai/llm"
import {
  nextManthanCompactMarkers,
  parseManthanCompactMarkers,
  takeManthanContext,
  shouldManthanCompactAutocontinue,
  MANTHAN_COMPACT_CONTINUE_TEXT,
  requestManthanCompact,
  isManthanProviderID,
  manthanClientCompactAllowed,
  createManthanThinkContentGate,
  extractManthanThinkLeak,
  buildManthanCompactJsonl,
  formatManthanCompactStderrLine,
  isManthanLaunchMode,
} from "@/provider/manthan"
import { NotFoundError } from "@/storage/storage"
import {
  evaluateToolLoop,
  peekToolLoopPivot,
  requestToolLoopPivot,
  stripLeakedToolMarkup,
  toolInvocationsFromMessages,
  toolLoopKey,
  ToolLoopAbortError,
} from "./loop-detection"
import { pruneManthanLocalToolOutputs } from "./manthan-prune"

export type Result = "compact" | "stop" | "continue" | "pivot"

export interface Handle {
  readonly message: SessionV1.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
  ) => Effect.Effect<SessionV1.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: SessionV1.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
}

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: SessionV1.ToolPart["id"]
  messageID: SessionV1.ToolPart["messageID"]
  sessionID: SessionV1.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: SessionV1.TextPart | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
}

type StreamEvent = LLMEvent

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const snapshot = yield* Snapshot.Service
    const llm = yield* LLM.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service
    const database = yield* Database.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const manthanProvider =
        isManthanProviderID(input.assistantMessage.providerID) || isManthanProviderID(input.model.providerID)
      const manthanThink = manthanProvider
        ? createManthanThinkContentGate({
            // Interleaved models (Laguna) already get reasoning_content from the
            // API — assumeThinking would mis-route the answer into Thinking.
            assumeThinking:
              input.model.capabilities?.reasoning === true &&
              !input.model.capabilities?.interleaved,
          })
        : null
      const manthanLeakReasoningKey = "manthan-think-leak"
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
        reasoningMap: {},
      }
      let aborted = false

      const appendManthanLeakReasoning = Effect.fn("SessionProcessor.appendManthanLeakReasoning")(
        function* (text: string) {
          if (!text) return
          if (!(manthanLeakReasoningKey in ctx.reasoningMap)) {
            ctx.reasoningMap[manthanLeakReasoningKey] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
            }
            yield* session.updatePart(ctx.reasoningMap[manthanLeakReasoningKey])
          }
          ctx.reasoningMap[manthanLeakReasoningKey].text += text
          yield* session.updatePartDelta({
            sessionID: ctx.reasoningMap[manthanLeakReasoningKey].sessionID,
            messageID: ctx.reasoningMap[manthanLeakReasoningKey].messageID,
            partID: ctx.reasoningMap[manthanLeakReasoningKey].id,
            field: "text",
            delta: text,
          })
        },
      )

      const appendAssistantText = Effect.fn("SessionProcessor.appendAssistantText")(function* (
        text: string,
        providerMetadata?: Record<string, unknown>,
      ) {
        if (!text) return
        if (!ctx.currentText) {
          ctx.currentText = {
            id: PartID.ascending(),
            messageID: ctx.assistantMessage.id,
            sessionID: ctx.assistantMessage.sessionID,
            type: "text",
            text: "",
            time: { start: Date.now() },
            metadata: providerMetadata,
          }
          yield* session.updatePart(ctx.currentText)
        }
        const next = stripLeakedToolMarkup(ctx.currentText.text + text)
        if (next === ctx.currentText.text) return
        const delta = next.startsWith(ctx.currentText.text) ? next.slice(ctx.currentText.text.length) : null
        ctx.currentText.text = next
        if (providerMetadata) ctx.currentText.metadata = providerMetadata
        if (delta) {
          yield* session.updatePartDelta({
            sessionID: ctx.currentText.sessionID,
            messageID: ctx.currentText.messageID,
            partID: ctx.currentText.id,
            field: "text",
            delta,
          })
        } else {
          yield* session.updatePart(ctx.currentText)
        }
      })

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return undefined
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return undefined
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: SessionV1.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: output.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            // Keep metadata streamed while running so failures retain progress detail (e.g. execute's child calls).
            metadata: match.part.state.metadata,
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        if (error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        // Pivot threshold: queue a forced text-only turn — do not halt for the user.
        if (error instanceof ToolLoopAbortError && error.fatal) {
          requestToolLoopPivot(ctx.sessionID, {
            tool: error.tool,
            count: error.count,
            key: error.key,
          })
        } else if (ToolLoopAbortError.isFatal(error)) {
          requestToolLoopPivot(ctx.sessionID, { tool: "tool", count: 0 })
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (reasoningID: string) {
        if (!(reasoningID in ctx.reasoningMap)) return
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.reasoningMap[reasoningID].text = ctx.reasoningMap[reasoningID].text
        ctx.reasoningMap[reasoningID].time = { ...ctx.reasoningMap[reasoningID].time, end: Date.now() }
        yield* session.updatePart(ctx.reasoningMap[reasoningID])
        delete ctx.reasoningMap[reasoningID]
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
      }) {
        const existing = yield* readToolCall(input.id)
        if (existing) {
          if (!input.providerExecuted || existing.part.metadata?.providerExecuted) return existing
          const part = yield* session.updatePart({
            ...existing.part,
            metadata: { ...existing.part.metadata, providerExecuted: true },
          })
          ctx.toolcalls[input.id] = {
            ...existing.call,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          }
          return { call: ctx.toolcalls[input.id], part }
        }
        const part = yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: input.name,
          callID: input.id,
          state: { status: "pending", input: {}, raw: "" },
          metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
        } satisfies SessionV1.ToolPart)
        ctx.toolcalls[input.id] = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return { call: ctx.toolcalls[input.id], part }
      })

      const isFilePart = (value: unknown): value is SessionV1.FilePart => Schema.is(SessionV1.FilePart)(value)

      const toolResultOutput = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): { title: string; metadata: Record<string, any>; output: string; attachments?: SessionV1.FilePart[] } => {
        if (isRecord(value.result.value) && typeof value.result.value.output === "string") {
          return {
            title: typeof value.result.value.title === "string" ? value.result.value.title : value.name,
            metadata: isRecord(value.result.value.metadata) ? value.result.value.metadata : {},
            output: value.result.value.output,
            attachments: Array.isArray(value.result.value.attachments)
              ? value.result.value.attachments.filter(isFilePart)
              : undefined,
          }
        }
        return {
          title: value.name,
          metadata: value.result.type === "json" && isRecord(value.result.value) ? value.result.value : {},
          output:
            typeof value.result.value === "string" ? value.result.value : (JSON.stringify(value.result.value) ?? ""),
        }
      }

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            manthanThink?.noteUpstreamReasoning()
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta":
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.reasoningMap)) return
            manthanThink?.noteUpstreamReasoning()
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            if (value.providerMetadata && value.id in ctx.reasoningMap) {
              ctx.reasoningMap[value.id].metadata = value.providerMetadata
            }
            yield* finishReasoning(value.id)
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            return

          case "tool-input-delta":
            yield* ensureToolCall(value)
            return

          case "tool-input-end": {
            yield* ensureToolCall(value)
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            const input = isRecord(value.input) ? value.input : { value: value.input }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input }
                  : {
                      status: "running",
                      input,
                      time: { start: Date.now() },
                    },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const page = yield* MessageV2.page({
              sessionID: ctx.assistantMessage.sessionID,
              limit: 40,
            }).pipe(Effect.provideService(Database.Service, database))
            const history = toolInvocationsFromMessages(
              page.items.map((msg) => ({
                parts: (msg.parts ?? []).filter(
                  (p) => !(p.type === "tool" && "callID" in p && p.callID === value.id),
                ),
              })),
            )
            const decision = evaluateToolLoop(
              history,
              { tool: value.name, input },
              { sessionID: ctx.assistantMessage.sessionID },
            )
            if (!decision.refuse) return

            yield* failToolCall(
              value.id,
              new ToolLoopAbortError(value.name, decision.count, {
                fatal: decision.pivot,
                key: toolLoopKey(value.name, input),
              }),
            )
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.id)
            if (!toolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              yield* failToolCall(value.id, value.result.value)
              return
            }
            const rawOutput = toolResultOutput(value)
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                ? image.normalize(attachment).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Image.ResizerUnavailableError,
                      () => Effect.succeed(attachment),
                    ),
                    Effect.exit,
                  )
                : Effect.succeed(Exit.succeed<SessionV1.FilePart>(attachment)),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
            const output = {
              ...rawOutput,
              output:
                omitted === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            yield* completeToolCall(value.id, output)
            return
          }

          case "tool-error": {
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            return
          }

          case "provider-error":
            throw new Error(value.message)

          case "step-start":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "step-finish": {
            const completedSnapshot = yield* snapshot.track()
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            ctx.assistantMessage.finish = value.reason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.reason,
              snapshot: completedSnapshot,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            const manthan = takeManthanContext(ctx.sessionID)
            let manthanCompacted = false
            if (manthan) {
              const current = yield* session.get(ctx.sessionID).pipe(
                Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)),
              )
              if (current) {
                const prevManthan =
                  current.metadata && typeof current.metadata === "object"
                    ? (current.metadata as Record<string, unknown>).manthan
                    : undefined
                const prevMarkers = parseManthanCompactMarkers(
                  prevManthan && typeof prevManthan === "object"
                    ? (prevManthan as Record<string, unknown>).compact_markers
                    : undefined,
                )
                const { markers, added } = nextManthanCompactMarkers(prevMarkers, {
                  compactionStatus: manthan.compaction_status,
                  epoch: manthan.cache_epoch ?? manthan.cache_generation,
                  messageID: ctx.assistantMessage.id,
                  summary: manthan.compact_summary,
                  compactReason: manthan.compact_reason,
                })
                manthanCompacted = added
                if (manthanCompacted) {
                  yield* pruneManthanLocalToolOutputs({
                    sessionID: ctx.sessionID,
                    mode: "post_compact",
                    compactMessageID: ctx.assistantMessage.id,
                  }).pipe(Effect.ignore)
                }
                // Markers only — never enqueue type:compaction. That part becomes a
                // prompt-loop task and runs OpenCode's Objective LLM summarizer,
                // which paints a second "Subagent context summarised" right after
                // Manthan's divider.
                yield* session.setMetadata({
                  sessionID: ctx.sessionID,
                  metadata: {
                    ...(current.metadata ?? {}),
                    manthan: { ...manthan, compact_markers: markers },
                  },
                })
                // Keep the loop alive after Manthan compact (esp. subagents).
                // finish:stop on the condensed turn would otherwise exit runLoop.
                if (
                  shouldManthanCompactAutocontinue({
                    added,
                    finish: ctx.assistantMessage.finish,
                    error: ctx.assistantMessage.error,
                  })
                ) {
                  const continueMsg = yield* session.updateMessage({
                    id: MessageID.ascending(),
                    role: "user",
                    sessionID: ctx.sessionID,
                    time: { created: Date.now() },
                    agent: ctx.assistantMessage.agent,
                    model: {
                      providerID: ctx.assistantMessage.providerID,
                      modelID: ctx.assistantMessage.modelID,
                    },
                  })
                  yield* session.updatePart({
                    id: PartID.ascending(),
                    messageID: continueMsg.id,
                    sessionID: ctx.sessionID,
                    type: "text",
                    metadata: { compaction_continue: true, manthan_compact_continue: true },
                    synthetic: true,
                    text: MANTHAN_COMPACT_CONTINUE_TEXT,
                    time: { start: Date.now(), end: Date.now() },
                  })
                }
                const compactTelemetry = buildManthanCompactJsonl(manthan, {
                  messageID: ctx.assistantMessage.id,
                })
                if (compactTelemetry && (manthanCompacted || manthan.compaction_status === "compacted")) {
                  yield* session.updatePart({
                    id: PartID.ascending(),
                    messageID: ctx.assistantMessage.id,
                    sessionID: ctx.sessionID,
                    type: "text",
                    synthetic: true,
                    text: compactTelemetry.summary_preview || "Manthan server compacted context.",
                    time: { start: Date.now(), end: Date.now() },
                    metadata: { manthan_compact: true, ...compactTelemetry },
                  })
                  if (isManthanLaunchMode()) {
                    yield* Effect.sync(() => {
                      try {
                        if (typeof process !== "undefined") {
                          process.stderr?.write?.(
                            `${formatManthanCompactStderrLine(compactTelemetry)}\n`,
                          )
                        }
                      } catch {
                        /* --format json / no stderr */
                      }
                    })
                  }
                }
              }
            }
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            // Manthan already condensed this turn — do not enqueue OpenCode
            // compaction.create (second "Subagent context summarised").
            if (
              !manthanCompacted &&
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            // Manthan think-gate may route leading deltas to reasoning; create the
            // text part lazily when answer content arrives.
            if (manthanThink) return
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta": {
            if (manthanThink) {
              for (const piece of manthanThink.push(value.text)) {
                if (piece.reasoning) yield* appendManthanLeakReasoning(piece.reasoning)
                if (piece.content) {
                  yield* appendAssistantText(piece.content, value.providerMetadata)
                }
              }
              return
            }
            if (!ctx.currentText) return
            const next = stripLeakedToolMarkup(ctx.currentText.text + value.text)
            if (next === ctx.currentText.text) return
            const delta = next.startsWith(ctx.currentText.text) ? next.slice(ctx.currentText.text.length) : null
            ctx.currentText.text = next
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            if (delta) {
              yield* session.updatePartDelta({
                sessionID: ctx.currentText.sessionID,
                messageID: ctx.currentText.messageID,
                partID: ctx.currentText.id,
                field: "text",
                delta,
              })
            } else {
              yield* session.updatePart(ctx.currentText)
            }
            return
          }

          case "text-end":
            if (manthanThink) {
              for (const piece of manthanThink.flush()) {
                if (piece.reasoning) yield* appendManthanLeakReasoning(piece.reasoning)
                if (piece.content) yield* appendAssistantText(piece.content)
              }
            }
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = stripLeakedToolMarkup(ctx.currentText.text)
            if (manthanProvider) {
              const leaked = extractManthanThinkLeak(ctx.currentText.text)
              if (leaked.reasoning) yield* appendManthanLeakReasoning(leaked.reasoning)
              ctx.currentText.text = leaked.content
            }
            ctx.currentText.text = stripLeakedToolMarkup(
              (yield* plugin.trigger(
                "experimental.text.complete",
                {
                  sessionID: ctx.sessionID,
                  messageID: ctx.assistantMessage.id,
                  partID: ctx.currentText.id,
                },
                { text: ctx.currentText.text },
              )).text,
            )
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            if (manthanLeakReasoningKey in ctx.reasoningMap) {
              yield* finishReasoning(manthanLeakReasoningKey)
            }
            ctx.currentText = undefined
            return

          case "finish":
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          if (manthanThink) {
            for (const piece of manthanThink.flush()) {
              if (piece.reasoning) yield* appendManthanLeakReasoning(piece.reasoning)
              if (piece.content) {
                ctx.currentText.text = stripLeakedToolMarkup(ctx.currentText.text + piece.content)
              }
            }
          }
          const end = Date.now()
          ctx.currentText.text = stripLeakedToolMarkup(ctx.currentText.text)
          if (manthanProvider) {
            const leaked = extractManthanThinkLeak(ctx.currentText.text)
            if (leaked.reasoning) yield* appendManthanLeakReasoning(leaked.reasoning)
            ctx.currentText.text = leaked.content
          }
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        yield* Effect.logError("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
          error: errorMessage(e),
          stack: e instanceof Error ? e.stack : undefined,
        })
        const error = parse(e)
        if (SessionV1.ContextOverflowError.isInstance(error)) {
          if (isManthanProviderID(ctx.assistantMessage.providerID) && !manthanClientCompactAllowed()) {
            // Shrink local history before retry — otherwise 413 loops with the same fat body.
            yield* pruneManthanLocalToolOutputs({
              sessionID: ctx.sessionID,
              mode: "overflow",
            }).pipe(Effect.ignore)
            // Option A: do not surface overflow as a hard error or enqueue OpenCode
            // compaction UI — next turn sends x-manthan-compact for the API.
            requestManthanCompact(ctx.sessionID)
            ctx.needsCompaction = true
            yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            return
          }
          if ((yield* config.get()).compaction?.auto === false && !ctx.assistantMessage.summary) {
            ctx.assistantMessage.error = error
            ctx.assistantMessage.finish = "error"
            yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            yield* status.set(ctx.sessionID, { type: "idle" })
            return
          }
          ctx.needsCompaction = true
          yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        ctx.assistantMessage.error = error
        yield* events.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        yield* Effect.logInfo("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
        })
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            yield* status.set(ctx.sessionID, { type: "busy" })
            const stream = llm.stream(streamInput)

            yield* stream.pipe(
              Stream.tap((event) => handleEvent(event)),
              // Stop draining on compaction OR tool-loop hard abort — otherwise a
              // multi-event/multi-step stream could keep going after blocked=true.
              Stream.takeUntil(() => ctx.needsCompaction || ctx.blocked),
              Stream.runDrain,
            )
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.retry(
              SessionRetry.policy({
                provider: input.model.providerID,
                parse,
                set: (info) => {
                  return status.set(ctx.sessionID, {
                    type: "retry",
                    attempt: info.attempt,
                    message: info.message,
                    action: info.action,
                    next: info.next,
                  })
                },
              }),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          if (peekToolLoopPivot(ctx.sessionID)) return "pivot"
          return "continue"
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        updateToolCall,
        completeToolCall,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Session.node,
    Config.node,
    Snapshot.node,
    LLM.node,
    Plugin.node,
    SessionSummary.node,
    SessionStatus.node,
    Image.node,
    EventV2Bridge.node,
    Database.node,
  ],
})

export * as SessionProcessor from "./processor"
