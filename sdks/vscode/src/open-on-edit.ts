import * as vscode from "vscode"
import {
  type EditReveal,
  type OpencodeEvent,
  createContentLineCount,
  highlightLinesFromReveal,
  parseSseChunk,
  refineEditReveal,
  revealFromToolPart,
} from "./open-on-edit-helpers"

export type { EditReveal, OpencodeEvent }
export {
  createContentLineCount,
  highlightLinesFromReveal,
  lineFromUnifiedDiff,
  lineRangeFromNeedle,
  parseSseChunk,
  refineEditReveal,
  revealFromToolPart,
} from "./open-on-edit-helpers"

type Tracked = {
  fsPath: string
  /** We created this tab for Manthan — eligible for auto-close. */
  openedByUs: boolean
  /** Tab existed before we touched it — never auto-close. */
  preExisting: boolean
  /** Next open should jump to EOF (create). */
  expectCreate: boolean
  closeTimer?: ReturnType<typeof setTimeout>
  highlightTimers?: ReturnType<typeof setTimeout>[]
}

export type OpenOnEditOptions = {
  enabled: () => boolean
  autoClose: () => boolean
  /** Highlight hold ms; 0 disables. Default 1100. */
  highlightMs?: () => number
  /** When true, editor takes focus (terminal loses primacy). Default false. */
  stealFocus?: () => boolean
  /** Extra ms after highlight clears before auto-close. Default 400. */
  closeAfterHighlightMs?: number
  /** Fallback close delay when highlight disabled. Default 1500. */
  closeDelayMs?: number
  directory?: () => string | undefined
}

const DEFAULT_HIGHLIGHT_MS = 1100
const DEFAULT_CLOSE_AFTER_HIGHLIGHT_MS = 400
const DEFAULT_CLOSE_DELAY_MS = 1500

/**
 * Subscribes to OpenCode `/event` and opens/reveals files Manthan edits.
 * Auto-closes tabs we opened once the edit settles, unless the user dirtied them.
 */
export class OpenOnEditController implements vscode.Disposable {
  private abort: AbortController | undefined
  private tracked = new Map<string, Tracked>()
  private readonly closeDelayMs: number
  private readonly closeAfterHighlightMs: number
  private disposed = false
  private readonly decoStrong: vscode.TextEditorDecorationType
  private readonly decoSoft: vscode.TextEditorDecorationType

  constructor(private readonly opts: OpenOnEditOptions) {
    this.closeDelayMs = opts.closeDelayMs ?? DEFAULT_CLOSE_DELAY_MS
    this.closeAfterHighlightMs = opts.closeAfterHighlightMs ?? DEFAULT_CLOSE_AFTER_HIGHLIGHT_MS
    // Theme find-match / overview colors — calm, not purple glow.
    this.decoStrong = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
      borderColor: new vscode.ThemeColor("editorOverviewRuler.findMatchForeground"),
      borderWidth: "0 0 0 2px",
      borderStyle: "solid",
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.findMatchForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    })
    this.decoSoft = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.selectionHighlightBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.findMatchForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    })
  }

  /** Start (or restart) SSE against the Manthan/OpenCode port. */
  start(port: number) {
    this.stopStream()
    if (!this.opts.enabled()) return
    const ac = new AbortController()
    this.abort = ac
    void this.streamLoop(port, ac.signal)
  }

  stopStream() {
    this.abort?.abort()
    this.abort = undefined
    for (const t of this.tracked.values()) {
      this.clearTimers(t)
    }
  }

  dispose() {
    this.disposed = true
    this.stopStream()
    this.tracked.clear()
    this.decoStrong.dispose()
    this.decoSoft.dispose()
  }

  /** Handle one OpenCode bus event (also used by tests). */
  async handleEvent(ev: OpencodeEvent) {
    if (!this.opts.enabled() || this.disposed) return
    const type = ev.type
    const props = ev.properties ?? {}

    if (type === "message.part.updated") {
      const part = props.part as
        | {
            type?: string
            tool?: string
            state?: {
              status?: string
              input?: Record<string, unknown>
              metadata?: Record<string, unknown>
            }
          }
        | undefined
      if (!part || part.type !== "tool") return
      const info = revealFromToolPart(part)
      if (!info) return

      const key = normalizePath(info.filePath)
      const prev = this.tracked.get(key)
      if (info.isCreate) {
        this.tracked.set(key, {
          fsPath: info.filePath,
          openedByUs: prev?.openedByUs ?? false,
          preExisting: prev?.preExisting ?? false,
          expectCreate: true,
          closeTimer: prev?.closeTimer,
          highlightTimers: prev?.highlightTimers,
        })
      }

      if (info.phase === "running") {
        if (info.isCreate) return // file may not exist yet
        await this.openPath(info.filePath, info.reveal, info.input)
        return
      }

      await this.openPath(
        info.filePath,
        info.isCreate || this.tracked.get(key)?.expectCreate ? { kind: "create" } : info.reveal,
        info.input,
      )
      this.scheduleClose(info.filePath)
      return
    }

    if (type === "file.edited") {
      const file = typeof props.file === "string" ? props.file : ""
      if (!file) return
      const prev = this.tracked.get(normalizePath(file))
      const reveal: EditReveal = prev?.expectCreate
        ? { kind: "create" }
        : { kind: "edit", startLine: -1, endLine: -1 }
      await this.openPath(file, reveal, {})
      this.scheduleClose(file)
      return
    }

    if (type === "session.idle") {
      if (!this.opts.autoClose()) return
      await this.closeAllEligible()
    }
  }

  private async openPath(
    filePath: string,
    reveal: EditReveal,
    input: { oldString?: string; newString?: string },
  ) {
    const key = normalizePath(filePath)
    const uri = vscode.Uri.file(filePath)

    const tabOpen = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .some((t) => t.input instanceof vscode.TabInputText && normalizePath(t.input.uri.fsPath) === key)
    const prev = this.tracked.get(key)
    const wasTrackedByUs = prev?.openedByUs === true
    const preExisting = tabOpen && !wasTrackedByUs

    let doc: vscode.TextDocument
    try {
      doc = await vscode.workspace.openTextDocument(uri)
    } catch {
      return
    }

    const stealFocus = this.opts.stealFocus?.() === true
    const editor = await vscode.window.showTextDocument(doc, {
      preview: true,
      preserveFocus: !stealFocus,
      viewColumn: vscode.ViewColumn.One,
    })

    const treatCreate = reveal.kind === "create" || prev?.expectCreate === true
    const resolved = treatCreate
      ? ({ kind: "create" } as EditReveal)
      : refineEditReveal(doc.getText(), reveal, input)
    applyReveal(editor, resolved, doc)

    if (prev?.highlightTimers) {
      for (const h of prev.highlightTimers) clearTimeout(h)
    }

    this.tracked.set(key, {
      fsPath: filePath,
      openedByUs: wasTrackedByUs || !preExisting,
      preExisting: preExisting || prev?.preExisting === true,
      expectCreate: false,
      closeTimer: prev?.closeTimer,
      highlightTimers: [],
    })
    if (preExisting) {
      const t = this.tracked.get(key)!
      t.preExisting = true
      t.openedByUs = false
    }

    const createLines = treatCreate ? createContentLineCount(input.newString) : undefined
    this.pulseHighlight(editor, doc, resolved, createLines)
  }

  private pulseHighlight(
    editor: vscode.TextEditor,
    doc: vscode.TextDocument,
    reveal: EditReveal,
    createLineCount?: number,
  ) {
    const ms = this.highlightMs()
    const key = normalizePath(doc.uri.fsPath)
    const tracked = this.tracked.get(key)

    editor.setDecorations(this.decoStrong, [])
    editor.setDecorations(this.decoSoft, [])
    if (ms <= 0 || !tracked) return

    const lines = highlightLinesFromReveal(reveal, doc.lineCount, { createLineCount })
    const startPos = doc.lineAt(lines.startLine).range.start
    const endPos = doc.lineAt(lines.endLine).range.end
    const range = new vscode.Range(startPos, endPos)

    editor.setDecorations(this.decoStrong, [range])

    const softAt = Math.max(80, Math.floor(ms * 0.55))
    const timers: ReturnType<typeof setTimeout>[] = []

    timers.push(
      setTimeout(() => {
        if (this.disposed) return
        editor.setDecorations(this.decoStrong, [])
        editor.setDecorations(this.decoSoft, [range])
      }, softAt),
    )
    timers.push(
      setTimeout(() => {
        if (this.disposed) return
        editor.setDecorations(this.decoStrong, [])
        editor.setDecorations(this.decoSoft, [])
      }, ms),
    )

    tracked.highlightTimers = timers
  }

  private highlightMs(): number {
    const n = this.opts.highlightMs?.()
    if (n == null || !Number.isFinite(n)) return DEFAULT_HIGHLIGHT_MS
    return Math.max(0, Math.floor(n))
  }

  private scheduleClose(filePath: string) {
    if (!this.opts.autoClose()) return
    const key = normalizePath(filePath)
    const t = this.tracked.get(key)
    if (!t || t.preExisting || !t.openedByUs) return
    if (t.closeTimer) clearTimeout(t.closeTimer)

    const highlight = this.highlightMs()
    const delay =
      highlight > 0 ? highlight + this.closeAfterHighlightMs : this.closeDelayMs

    t.closeTimer = setTimeout(() => {
      void this.closeIfEligible(filePath)
    }, delay)
  }

  private async closeIfEligible(filePath: string) {
    if (!this.opts.autoClose() || this.disposed) return
    const key = normalizePath(filePath)
    const t = this.tracked.get(key)
    if (!t || t.preExisting || !t.openedByUs) return

    const doc = vscode.workspace.textDocuments.find((d) => normalizePath(d.uri.fsPath) === key)
    if (doc?.isDirty) return

    const tab = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find((x) => x.input instanceof vscode.TabInputText && normalizePath(x.input.uri.fsPath) === key)
    if (!tab) {
      this.tracked.delete(key)
      return
    }
    if (tab.isDirty) return
    try {
      await vscode.window.tabGroups.close(tab, true)
    } catch {
      // ignore
    }
    this.tracked.delete(key)
  }

  private async closeAllEligible() {
    const entries = [...this.tracked.values()]
    for (const t of entries) {
      this.clearTimers(t)
      await this.closeIfEligible(t.fsPath)
    }
  }

  private clearTimers(t: Tracked) {
    if (t.closeTimer) clearTimeout(t.closeTimer)
    if (t.highlightTimers) {
      for (const h of t.highlightTimers) clearTimeout(h)
      t.highlightTimers = []
    }
  }

  private async streamLoop(port: number, signal: AbortSignal) {
    const directory = this.opts.directory?.()
    while (!signal.aborted && !this.disposed) {
      try {
        const headers: Record<string, string> = { Accept: "text/event-stream" }
        if (directory) headers["x-opencode-directory"] = directory
        const res = await fetch(`http://127.0.0.1:${port}/event`, { headers, signal })
        if (!res.ok || !res.body) {
          await sleep(1000, signal)
          continue
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ""
        while (!signal.aborted) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          buf = parseSseChunk(buf, (ev) => {
            void this.handleEvent(ev)
          })
        }
      } catch {
        if (signal.aborted) return
        await sleep(1000, signal)
      }
    }
  }
}

export function applyReveal(editor: vscode.TextEditor, reveal: EditReveal, doc: vscode.TextDocument) {
  if (reveal.kind === "create") {
    const last = Math.max(0, doc.lineCount - 1)
    const line = doc.lineAt(last)
    const pos = line.range.end
    editor.selection = new vscode.Selection(pos, pos)
    editor.revealRange(line.range, vscode.TextEditorRevealType.InCenter)
    return
  }

  const lines = highlightLinesFromReveal(reveal, doc.lineCount)
  const startPos = doc.lineAt(lines.startLine).range.start
  const endPos = doc.lineAt(lines.endLine).range.end
  editor.selection = new vscode.Selection(startPos, endPos)
  editor.revealRange(new vscode.Range(startPos, endPos), vscode.TextEditorRevealType.InCenter)
}

function normalizePath(p: string) {
  return p.replace(/\\/g, "/").toLowerCase()
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })
}
