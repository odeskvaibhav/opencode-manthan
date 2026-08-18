import * as vscode from "vscode"
import {
  fetchManthanContextFromCli,
  formatStatusBar,
  manthanHealthCheck,
  readManthanSettings,
} from "./manthan"
import { manthanCliCommand } from "./manthan-config"
import { OpenOnEditController } from "./open-on-edit"

const TERMINAL_NAME = "Manthan"
/** Kept for focusing older terminals opened before rebrand. */
const LEGACY_TERMINAL_NAMES = ["Manthan", "opencode"]

let statusBar: vscode.StatusBarItem | undefined
let statusTimer: ReturnType<typeof setInterval> | undefined
let activePort: number | undefined
let openOnEdit: OpenOnEditController | undefined

export function activate(context: vscode.ExtensionContext) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  statusBar.command = "opencode.openTerminal"
  statusBar.text = "Manthan"
  statusBar.tooltip = "Open Manthan (Cmd+Esc)"
  statusBar.show()
  context.subscriptions.push(statusBar)

  openOnEdit = new OpenOnEditController({
    enabled: () => readManthanSettings().openFilesOnEdit,
    autoClose: () => readManthanSettings().autoCloseEditedFiles,
    highlightMs: () => readManthanSettings().editHighlightMs,
    stealFocus: () => readManthanSettings().openOnEditStealFocus,
    directory: () => getWorkspaceDirectory(),
  })
  context.subscriptions.push(openOnEdit)

  const openNewTerminalDisposable = vscode.commands.registerCommand("opencode.openNewTerminal", async () => {
    await openTerminal(context)
  })

  const openTerminalDisposable = vscode.commands.registerCommand("opencode.openTerminal", async () => {
    const existing = vscode.window.terminals.find(
      (t) => LEGACY_TERMINAL_NAMES.includes(t.name) && t.exitStatus === undefined,
    )
    if (existing) {
      // @ts-ignore env on creationOptions
      const portRaw = existing.creationOptions?.env?.["_EXTENSION_OPENCODE_PORT"]
      const port = portRaw ? parseInt(String(portRaw), 10) : undefined
      if (port && Number.isFinite(port)) {
        try {
          await fetch(`http://127.0.0.1:${port}/app`, { signal: AbortSignal.timeout(400) })
          existing.show()
          activePort = port
          openOnEdit?.start(port)
          return
        } catch {
          existing.dispose()
        }
      } else {
        existing.dispose()
      }
    }
    await openTerminal(context)
  })

  const addFilepathDisposable = vscode.commands.registerCommand("opencode.addFilepathToTerminal", async () => {
    const fileRef = getActiveFile()
    if (!fileRef) return
    const terminal = vscode.window.activeTerminal
    if (!terminal || !LEGACY_TERMINAL_NAMES.includes(terminal.name)) return
    // @ts-ignore env on creationOptions
    const port = terminal.creationOptions.env?.["_EXTENSION_OPENCODE_PORT"]
    port ? await appendPrompt(parseInt(port), fileRef) : terminal.sendText(fileRef, false)
    terminal.show()
  })

  const openSettingsDisposable = vscode.commands.registerCommand("opencode.manthanSettings", async () => {
    await vscode.commands.executeCommand("workbench.action.openSettings", "manthan")
  })

  const healthDisposable = vscode.commands.registerCommand("opencode.manthanHealth", async () => {
    const settings = readManthanSettings()
    try {
      const msg = await manthanHealthCheck(settings)
      vscode.window.showInformationMessage(msg)
      if (statusBar) statusBar.text = "$(check) Manthan OK"
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      vscode.window.showErrorMessage(message)
      if (statusBar) statusBar.text = "$(error) Manthan"
    }
  })

  const docsDisposable = vscode.commands.registerCommand("opencode.manthanDocs", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: MANTHAN_ONEPAGER,
    })
    await vscode.window.showTextDocument(doc, { preview: true })
  })

  const condenseDisposable = vscode.commands.registerCommand("opencode.manthanCondense", async () => {
    const terminal = vscode.window.terminals.find((t) => LEGACY_TERMINAL_NAMES.includes(t.name))
    if (!terminal) {
      vscode.window.showWarningMessage("Open Manthan first (Open Manthan command).")
      return
    }
    terminal.show()
    // Slash command handled by TUI → summarize → Manthan x-manthan-compact path
    terminal.sendText("/compact", true)
    vscode.window.showInformationMessage("Requested Manthan context condense (/compact).")
  })

  context.subscriptions.push(
    openNewTerminalDisposable,
    openTerminalDisposable,
    addFilepathDisposable,
    openSettingsDisposable,
    healthDisposable,
    docsDisposable,
    condenseDisposable,
  )

  statusTimer = setInterval(() => {
    void refreshStatusBar()
  }, 4000)
  context.subscriptions.push({
    dispose: () => {
      if (statusTimer) clearInterval(statusTimer)
    },
  })

  async function openTerminal(ctx: vscode.ExtensionContext) {
    // Provider/model/key come from ~/.config/opencode/opencode.jsonc — no temp OPENCODE_CONFIG overlay.
    const settings = readManthanSettings()
    const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
    activePort = port
    const env: Record<string, string> = {
      _EXTENSION_OPENCODE_PORT: port.toString(),
      OPENCODE_CALLER: "vscode",
      OPENCODE_MANTHAN_MODE: "1",
    }
    const apiKey = settings.apiKey || process.env.MANTHAN_API_KEY
    if (apiKey) env.MANTHAN_API_KEY = apiKey
    const workspaceDir = getWorkspaceDirectory()
    if (workspaceDir) env.OPENCODE_LAUNCH_CWD = workspaceDir

    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      iconPath: vscode.Uri.file(ctx.asAbsolutePath("images/icon.png")),
      cwd: workspaceDir,
      location: {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      },
      env,
    })

    terminal.show()
    terminal.sendText(manthanCliCommand(settings.binary, port, workspaceDir))

    const fileRef = getActiveFile()
    let tries = 15
    let connected = false
    do {
      await new Promise((resolve) => setTimeout(resolve, 200))
      try {
        await fetch(`http://127.0.0.1:${port}/app`)
        connected = true
        break
      } catch {
        // retry
      }
      tries--
    } while (tries > 0)

    if (connected && fileRef) {
      await appendPrompt(port, `In ${fileRef}`)
      terminal.show()
    }
    openOnEdit?.start(port)
    void refreshStatusBar()
  }

  async function refreshStatusBar() {
    if (!statusBar || !activePort) return
    const settings = readManthanSettings()
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    try {
      const snap = await fetchManthanContextFromCli(activePort, folder)
      if (!snap) {
        statusBar.text = "Manthan · waiting"
        return
      }
      statusBar.text = formatStatusBar(snap, settings.showPowerFields)
      statusBar.tooltip = "Manthan context from session.metadata.manthan"
    } catch {
      statusBar.text = "Manthan"
    }
  }

  async function appendPrompt(port: number, text: string) {
    await fetch(`http://127.0.0.1:${port}/tui/append-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    })
  }

  function getWorkspaceDirectory(): string | undefined {
    const active = vscode.window.activeTextEditor?.document.uri
    if (active && active.scheme === "file") {
      const wf = vscode.workspace.getWorkspaceFolder(active)
      if (wf) return wf.uri.fsPath
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  }

  function getActiveFile() {
    const activeEditor = vscode.window.activeTextEditor
    if (!activeEditor) return
    const document = activeEditor.document
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
    if (!workspaceFolder) return
    const relativePath = vscode.workspace.asRelativePath(document.uri)
    let filepathWithAt = `@${relativePath}`
    const selection = activeEditor.selection
    if (!selection.isEmpty) {
      const startLine = selection.start.line + 1
      const endLine = selection.end.line + 1
      filepathWithAt += startLine === endLine ? `#L${startLine}` : `#L${startLine}-${endLine}`
    }
    return filepathWithAt
  }
}

export function deactivate() {
  if (statusTimer) clearInterval(statusTimer)
  openOnEdit?.dispose()
  openOnEdit = undefined
}

const MANTHAN_ONEPAGER = `# Manthan × OpenCode (VS Code)

## Option A — Manthan owns model context

- OpenCode **auto-compact is OFF** when talking to Manthan.
- Digests, active-budget compact, and Stop-preserve KV run on **Manthan**.
- Do **not** set \`OPENCODE_MANTHAN_ALLOW_CLIENT_COMPACT=1\` unless you intentionally want OpenCode's LLM summarizer back.

## Commands

- **Open Manthan** — runs \`manthan.binary\` against your global \`~/.config/opencode/opencode.jsonc\`
- **Manthan: Health check** — \`GET /v1/models\` (uses \`manthan.baseUrl\` / key only for this probe)
- **Manthan: Condense context** — sends \`/compact\` → \`x-manthan-compact\`

## Config

Edit **\`~/.config/opencode/opencode.jsonc\`** for base URL, API key, models, compaction. VS Code \`manthan.binary\` is the only launch setting that matters day-to-day.

Leave top-level \`model\` **unset** in \`~/.config/opencode/opencode.jsonc\` (never pin sidecar \`qwen3.5-4b\`). On every launch / new session Manthan opens the model picker (live \`/v1/models\` only); after you pick, warmup runs.

## Context bar

Status bar shows Manthan \`context_used\` / \`%\` from \`session.metadata.manthan\` (response headers). Enable **manthan.showPowerFields** for fresh tokens / reuse % / epoch.

## Open on edit

With **manthan.openFilesOnEdit** (default on), the extension listens to OpenCode SSE (\`/event\`) and opens files Manthan writes:

- **Edit** → center-reveal and select the change range (diff hunk or \`oldString\`/\`newString\` match), with a brief find-match highlight (strong → soft → clear).
- **Create** → cursor at last line; highlight spans new content when length is known.
- Focus stays in the terminal unless **manthan.openOnEditStealFocus** is on.
- **manthan.autoCloseEditedFiles** (default on) closes tabs *we* opened after the highlight fades (+~400ms), or on \`session.idle\`. Skips dirty / already-open tabs.
- **manthan.editHighlightMs** (default 1100, \`0\` = off) controls highlight hold time.

## Docs

See infer-pool \`docs/opencode-manthan-first-class-plan.md\` and \`docs/opencode-context-cache-plan.md\`.
`
