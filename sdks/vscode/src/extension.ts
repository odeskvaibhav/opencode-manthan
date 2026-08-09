import * as vscode from "vscode"
import {
  fetchManthanContextFromCli,
  formatStatusBar,
  manthanHealthCheck,
  readManthanSettings,
  writeTempManthanConfig,
} from "./manthan"

const TERMINAL_NAME = "Manthan"
/** Kept for focusing older terminals opened before rebrand. */
const LEGACY_TERMINAL_NAMES = ["Manthan", "opencode"]

let statusBar: vscode.StatusBarItem | undefined
let statusTimer: ReturnType<typeof setInterval> | undefined
let activePort: number | undefined

export function activate(context: vscode.ExtensionContext) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  statusBar.command = "opencode.manthanHealth"
  statusBar.text = "Manthan"
  statusBar.tooltip = "Manthan context (from OpenCode CLI session metadata)"
  statusBar.show()
  context.subscriptions.push(statusBar)

  const openNewTerminalDisposable = vscode.commands.registerCommand("opencode.openNewTerminal", async () => {
    await openTerminal(context)
  })

  const openTerminalDisposable = vscode.commands.registerCommand("opencode.openTerminal", async () => {
    const existing = vscode.window.terminals.find((t) => LEGACY_TERMINAL_NAMES.includes(t.name))
    if (existing) {
      existing.show()
      return
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
    const settings = readManthanSettings()
    if (!settings.apiKey && !process.env.MANTHAN_API_KEY) {
      const pick = await vscode.window.showWarningMessage(
        "Manthan API key not set. Add manthan.apiKey in settings or MANTHAN_API_KEY.",
        "Open settings",
        "Continue anyway",
      )
      if (pick === "Open settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "manthan.apiKey")
        return
      }
    }

    const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
    activePort = port
    const configPath = writeTempManthanConfig(settings)
    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      iconPath: {
        light: vscode.Uri.file(ctx.asAbsolutePath("images/button-dark.svg")),
        dark: vscode.Uri.file(ctx.asAbsolutePath("images/button-light.svg")),
      },
      location: {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      },
      env: {
        _EXTENSION_OPENCODE_PORT: port.toString(),
        OPENCODE_CALLER: "vscode",
        OPENCODE_CONFIG: configPath,
        OPENCODE_MANTHAN_MODE: "1",
        MANTHAN_API_KEY: settings.apiKey || process.env.MANTHAN_API_KEY || "",
      },
    })

    terminal.show()
    const bin = settings.binary.includes(" ") ? `"${settings.binary}"` : settings.binary
    terminal.sendText(`${bin} --port ${port}`)

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
}

const MANTHAN_ONEPAGER = `# Manthan × OpenCode (VS Code)

## Option A — Manthan owns model context

- OpenCode **auto-compact is OFF** when talking to Manthan.
- Digests, active-budget compact, and Stop-preserve KV run on **Manthan**.
- Do **not** set \`OPENCODE_MANTHAN_ALLOW_CLIENT_COMPACT=1\` unless you intentionally want OpenCode's LLM summarizer back.

## Commands

- **Open Manthan** — launches CLI with Manthan provider defaults
- **Manthan: Health check** — \`GET /v1/models\`
- **Manthan: Condense context** — sends \`/compact\` → \`x-manthan-compact\`
- **Manthan: Open settings** — URL, API key, model

## Context bar

Status bar shows Manthan \`context_used\` / \`%\` from \`session.metadata.manthan\` (response headers). Enable **manthan.showPowerFields** for fresh tokens / reuse % / epoch.

## Docs

See infer-pool \`docs/opencode-manthan-first-class-plan.md\` and \`docs/opencode-context-cache-plan.md\`.
`
