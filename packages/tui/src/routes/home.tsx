import { Prompt, type PromptRef } from "../component/prompt"
import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js"
import { Logo } from "../component/logo"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData, useRoute } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { usePluginRuntime } from "../plugin/runtime"
import { useEditorContext } from "../context/editor"
import { useTerminalDimensions } from "@opentui/solid"
import { useTuiConfig } from "../config"
import { useTheme } from "../context/theme"
import { HomeSessionDestinationProvider } from "./home/session-destination"
import { useManthanChatWarmup } from "./home/manthan-chat-warmup"
import { useDialog } from "../ui/dialog"
import { DialogModel } from "../component/dialog-model"
import { findManthanProvider, hasManthanProvider, isManthanLaunchMode } from "../util/manthan-context"

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

export function Home() {
  return (
    <HomeSessionDestinationProvider>
      <HomeInner />
    </HomeSessionDestinationProvider>
  )
}

function HomeInner() {
  const pluginRuntime = usePluginRuntime()
  const sync = useSync()
  const route = useRouteData("home")
  const routeNav = useRoute()
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const { theme } = useTheme()
  const dialog = useDialog()
  const warmup = useManthanChatWarmup()
  const promptMaxWidth = createMemo(() => {
    const configured = tuiConfig.prompt?.max_width
    if (configured === "auto") return Math.max(75, Math.floor(dimensions().width * 0.7))
    return configured ?? 75
  })
  let sent = false

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  // Manthan new session: model picker when home.pickModel (session.new / cold start).
  // Mid-session GPU/API blips never clear the pick — only session.new does.
  createEffect(() => {
    if (!route.pickModel) return
    if (!sync.ready || !local.model.ready) return
    if (args.prompt || args.model) return
    if (!isManthanLaunchMode() && !hasManthanProvider(sync.data.provider)) return
    const manthan = findManthanProvider(sync.data.provider)
    if (!manthan || Object.keys(manthan.models).length === 0) return
    const providerID = manthan.id
    routeNav.navigate({ type: "home", prompt: route.prompt, pickModel: false })
    queueMicrotask(() => {
      dialog.replace(() => <DialogModel providerID={providerID} />)
    })
  })

  return (
    <>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />
        <box flexShrink={0} alignItems="center">
          <Logo animate={warmup.active()} />
          <Show when={warmup.active()}>
            <box paddingTop={1} alignItems="center">
              <text fg={theme.textMuted}>{warmup.line()}</text>
            </box>
          </Show>
        </box>
        <box height={1} minHeight={0} flexShrink={1} />
        <box width="100%" maxWidth={promptMaxWidth()} zIndex={1000} paddingTop={1} flexShrink={0}>
          <pluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
            <Prompt
              ref={bind}
              disabled={warmup.disabled()}
              right={<pluginRuntime.Slot name="home_prompt_right" />}
              placeholders={placeholder}
            />
          </pluginRuntime.Slot>
        </box>
        <pluginRuntime.Slot name="home_bottom" />
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <pluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </>
  )
}
