# Manthan for VS Code

Manthan-branded OpenCode launcher. **Option A:** Manthan owns model-facing digests and compaction; OpenCode auto-compact stays off.

## Setup

1. Install this extension (local VSIX or `F5` from `sdks/vscode`).
2. Set **Manthan: Open settings**:
   - `manthan.baseUrl` — e.g. `http://127.0.0.1:3000/v1`
   - `manthan.apiKey` — or export `MANTHAN_API_KEY`
   - `manthan.model` — default `manthan/laguna-xs-2.1-sharded`
   - `manthan.binary` — OpenCode CLI built from this fork (`opencode` on PATH)
3. Command Palette → **Manthan: Open**

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

## Tracker

`infer-pool/docs/opencode-manthan-first-class-plan.md`
