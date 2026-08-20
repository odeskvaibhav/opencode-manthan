# Manthan for VS Code

Manthan-branded OpenCode launcher. **Option A:** Manthan owns model-facing digests and compaction; OpenCode auto-compact stays off.

## Ship & install (local)

From repo root — this is the durable loop:

```bash
# Build VSIX → install into VS Code (Cmd+Esc after Reload Window)
./scripts/install-vscode.sh

# Same, and remove stock OpenCode (same command IDs — keep only one)
./scripts/install-vscode.sh --replace-stock

# Dev loop: symlink source tree (edit → Reload Window, no VSIX)
./scripts/install-vscode.sh --dev
```

Or from `sdks/vscode`:

```bash
bun run install:code        # VSIX + code --install-extension
bun run install:code:dev    # symlink
bun run vsix                # package only → manthan-opencode-<ver>.vsix
```

Packaging does **not** use `vsce` (broken iconv extract here); `scripts/package-vscode-vsix.mjs` zips a valid VSIX.

The install script sets `manthan.binary` to `scripts/opencode-manthan.sh` (fork CLI, not Homebrew).

## Setup

Friend laptop (clone → config → extension): **[INSTALL.md](../../INSTALL.md)**.

1. Copy example config: `./scripts/install-opencode-config.sh`  
   → `~/.config/opencode/opencode.jsonc` (source of truth). Set `MANTHAN_API_KEY`.
2. Run `./scripts/install-vscode.sh` once (or `--dev` while hacking) so `manthan.binary` points at the fork.
3. **Reload Window**, then **Cmd+Esc** — launches the CLI with your global config only (no temp overlay).

## Option A (important)

- Injected config sets `compaction.auto: false` / `prune: false`.
- Fork also forces this when the provider is Manthan.
- Escape hatch (not recommended): `OPENCODE_MANTHAN_ALLOW_CLIENT_COMPACT=1`

## Commands

| Command | Action |
|---------|--------|
| Manthan: Open | Terminal + Manthan config |
| Manthan: Health check | `GET /v1/models` |
| Manthan: Condense context | `/compact` → Manthan `x-manthan-compact` |
| Manthan: Option A docs | In-editor one-pager |
| Manthan: Open settings | VS Code settings |

## Context status bar

Shows Manthan `context_used` / `%` from CLI `session.metadata.manthan`. Enable `manthan.showPowerFields` for fresh / reuse / epoch.

## Open on edit (interactive)

Default **on** (`manthan.openFilesOnEdit`): when Manthan creates/edits a file, VS Code opens it beside the terminal (focus stays in the terminal unless `manthan.openOnEditStealFocus`).

| Case | Cursor / highlight |
|------|--------------------|
| Edit | Center-reveal change range; temporary find-match line highlight (strong → soft → clear) |
| Create | EOF; highlight last N lines when write content length is known |

`manthan.autoCloseEditedFiles` (default off) keeps edited/created tabs open. Turn it on to close tabs the extension opened after the highlight fades (also on session idle). Does **not** close dirty tabs or files you already had open.

`manthan.editHighlightMs` (default `1100`, `0` = off) sets how long the highlight holds.

Turn settings off under **Manthan: Open settings** if you want a quieter editor.

## Tracker

`infer-pool/docs/opencode-manthan-first-class-plan.md`
