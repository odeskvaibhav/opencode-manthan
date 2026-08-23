import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Effect, Exit, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import { isManthanLaunchMode } from "../provider/manthan"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

/**
 * Manthan is typically one GPU worker. Parallel `task` tool calls fight for that
 * slot and look wedged (trivial bash/read stuck for minutes). Cap to one in-flight
 * subagent while OPENCODE_MANTHAN_MODE is on (VS Code + soak).
 */
let manthanTaskInflight = 0

/** @internal test helper */
export function manthanTaskInflightCount() {
  return manthanTaskInflight
}

/** @internal test helper */
export function resetManthanTaskSlot() {
  manthanTaskInflight = 0
}

export function tryAcquireManthanTaskSlot(): boolean {
  if (!isManthanLaunchMode()) return true
  if (manthanTaskInflight >= 1) return false
  manthanTaskInflight += 1
  return true
}

export function releaseManthanTaskSlot(): void {
  if (!isManthanLaunchMode()) return
  if (manthanTaskInflight > 0) manthanTaskInflight -= 1
}

const MANTHAN_PARALLEL_TASK_BLOCKED = [
  "ERROR: Another subagent is already running.",
  "Manthan has one inference worker — do NOT launch parallel task tools.",
  "Wait for the current task to finish (or work with read/grep/bash yourself), then call task at most once.",
].join(" ")

type TaskMetadata = {
  parentSessionId: SessionID
  sessionId?: SessionID
  duplicateTaskBlocked?: boolean
  parallelTaskBlocked?: boolean
  background?: boolean
  jobId?: SessionID
  model?: {
    modelID: SessionV1.Assistant["modelID"]
    providerID: SessionV1.Assistant["providerID"]
  }
}

/** Normalize task description+prompt so repeat calls collide. */
export function taskWorkKey(description: string, prompt: string): string {
  return `${description}\n${prompt}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400)
}

/**
 * If the parent already got a completed task with the same work, reuse it.
 * Stops Qwen/etc. from spawning endless identical helpers.
 */
export function findRecentDuplicateCompletedTask(input: {
  description: string
  prompt: string
  messages: Array<{
    parts: Array<{
      type: string
      tool?: string
      state?: {
        status?: string
        input?: Record<string, unknown>
        output?: string
      }
    }>
  }>
}): { output: string; sessionId?: string } | undefined {
  const want = taskWorkKey(input.description, input.prompt)
  if (want.length < 12) return undefined
  for (let mi = input.messages.length - 1; mi >= 0; mi--) {
    const parts = input.messages[mi]?.parts ?? []
    for (let pi = parts.length - 1; pi >= 0; pi--) {
      const part = parts[pi]!
      if (part.type !== "tool" || part.tool !== "task") continue
      const st = part.state
      if (st?.status !== "completed" || !st.output) continue
      const prevDesc = String(st.input?.description ?? "")
      const prevPrompt = String(st.input?.prompt ?? "")
      if (taskWorkKey(prevDesc, prevPrompt) !== want) continue
      return { output: st.output, sessionId: String(st.input?.task_id ?? "") || undefined }
    }
  }
  return undefined
}

const TASK_COMPLETED_STOP =
  "\n\nIMPORTANT: This task finished successfully. Relay the <task_result> to the user now in a text reply and STOP. " +
  "Do NOT call the task tool again for the same work."

export function formatTaskToolOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  const body = [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
  if (input.state === "completed") return body + TASK_COMPLETED_STOP
  return body
}

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  return formatTaskToolOutput(input)
}

export const TaskTool = Tool.define<
  typeof Parameters,
  TaskMetadata,
  | Agent.Service
  | BackgroundJob.Service
  | Config.Service
  | Session.Service
  | Scope.Scope
  | RuntimeFlags.Service
  | Database.Service
>(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      // Same work already finished in this parent session → reuse, do not spawn again.
      // (Resume via task_id is still allowed.)
      if (!params.task_id) {
        const recent = yield* sessions.messages({ sessionID: ctx.sessionID, limit: 40 }).pipe(Effect.orDie)
        const dup = findRecentDuplicateCompletedTask({
          description: params.description,
          prompt: params.prompt,
          messages: recent,
        })
        if (dup?.output) {
          return {
            title: params.description,
            metadata: {
              parentSessionId: ctx.sessionID,
              duplicateTaskBlocked: true,
            } satisfies TaskMetadata,
            output:
              dup.output +
              "\n\nNOTE: Identical task already completed above. Use that result — do not spawn another helper.",
          }
        }
      }

      // Single-worker Manthan: refuse *new* parallel task spawns (sync before any yield).
      // Resume via task_id does not take another slot.
      const manthanNewTask = !params.task_id
      if (manthanNewTask && !tryAcquireManthanTaskSlot()) {
        return {
          title: params.description,
          metadata: {
            parentSessionId: ctx.sessionID,
            parallelTaskBlocked: true,
          } satisfies TaskMetadata,
          output: MANTHAN_PARALLEL_TASK_BLOCKED,
        }
      }
      let manthanSlotHeld = manthanNewTask && isManthanLaunchMode()
      const releaseManthanSlotIfHeld = () => {
        if (!manthanSlotHeld) return
        manthanSlotHeld = false
        releaseManthanTaskSlot()
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        releaseManthanSlotIfHeld()
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const session = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        }))

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") {
        releaseManthanSlotIfHeld()
        return yield* Effect.fail(new Error("Not an assistant message"))
      }
      const variant = msg.info.variant

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) {
        releaseManthanSlotIfHeld()
        return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      }

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        const parent = yield* sessions.get(ctx.sessionID)
        const parentTitle = parent.title?.trim() || "parent session"
        // Light C: task brief only — never dump parent transcript into the child.
        const brief = {
          type: "text" as const,
          synthetic: true,
          text: [
            "<parent_task_brief>",
            `You are a subagent working on: ${params.description}`,
            `Parent session: ${parentTitle}`,
            "Your context is isolated from the parent. Work from this brief and your tool results only.",
            "When finished, return one concise final answer for the parent agent.",
            "</parent_task_brief>",
          ].join("\n"),
        }
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: next.model ? undefined : variant,
          agent: next.name,
          parts: [brief, ...parts],
        })
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : `Background task failed: ${params.description}`,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      const runWithSlot = () =>
        runTask().pipe(
          Effect.ensuring(Effect.sync(releaseManthanSlotIfHeld)),
          Effect.onInterrupt(() => ops.cancel(nextSession.id)),
        )

      if (yield* background.extend({ id: nextSession.id, run: runWithSlot() })) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all([
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ]),
        run: runWithSlot(),
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: params.description,
              metadata,
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<TaskMetadata>) =>
        run(params, ctx).pipe(Effect.orDie) as Effect.Effect<Tool.ExecuteResult<TaskMetadata>>,
    } satisfies Tool.DefWithoutID<typeof Parameters, TaskMetadata>
  }),
)
