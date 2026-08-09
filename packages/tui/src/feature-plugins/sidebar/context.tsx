import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"
import { compactAtFromModel, manthanContextFromMetadata } from "../../util/manthan-context"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)

  const state = createMemo(() => {
    const manthan = manthanContextFromMetadata(session()?.metadata as Record<string, unknown> | undefined)
    if (manthan && (manthan.context_used != null || manthan.context_usage_percent != null || manthan.context_limit != null)) {
      return {
        tokens: manthan.context_used ?? 0,
        limit: manthan.context_limit,
        percent: manthan.context_usage_percent != null ? Math.round(manthan.context_usage_percent) : null,
        compactAt: manthan.compaction_threshold != null ? Math.round(manthan.compaction_threshold) : null,
        source: "manthan" as const,
        status: manthan.compaction_status,
        power: {
          fresh: manthan.newly_evaluated_tokens,
          reuse: manthan.cache_reuse_percent != null ? Math.round(manthan.cache_reuse_percent) : null,
          epoch: manthan.cache_epoch,
        },
      }
    }

    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        limit: null as number | null,
        percent: null,
        compactAt: null as number | null,
        source: "local" as const,
        status: null as string | null,
        power: null as null,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      limit: model?.limit.context ?? null,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
      compactAt: compactAtFromModel(model),
      source: "local" as const,
      status: null as string | null,
      power: null as null,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>
        {state().tokens.toLocaleString()}
        {state().limit != null ? ` / ${Number(state().limit).toLocaleString()}` : ""} tokens
      </text>
      <text fg={theme().textMuted}>
        {state().percent ?? 0}% used{state().source === "manthan" ? " · Manthan" : ""}
      </text>
      {state().compactAt != null ? (
        <text fg={theme().textMuted}>compact at {state().compactAt}%</text>
      ) : null}
      {state().status && state().status !== "ok" && state().status !== "none" && state().status !== "normal" ? (
        <text fg={theme().textMuted}>{state().status}</text>
      ) : null}
      <Show when={state().source === "manthan" && state().power}>
        <text fg={theme().textMuted}>fresh {state().power!.fresh ?? "—"}</text>
        <text fg={theme().textMuted}>reuse {state().power!.reuse ?? "—"}%</text>
        <text fg={theme().textMuted}>epoch {state().power!.epoch ?? "—"}</text>
      </Show>
      <text fg={theme().textMuted}>{money.format(cost())} spent</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
