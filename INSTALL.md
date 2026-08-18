# Install Manthan OpenCode (friend laptop)

Needs: **git**, **[bun](https://bun.sh)**, **VS Code** with the `code` CLI  
(`Cmd+Shift+P` → “Shell Command: Install 'code' command in PATH”).

No Homebrew OpenCode. This repo **is** the client.

## 1. Clone + deps

```bash
git clone https://github.com/odeskvaibhav/opencode-manthan.git
cd opencode-manthan
bun install
```

If you already have `infer-pool`, use `infer-pool/opencode-manthan` instead of cloning.

## 2. Config (API URL + models)

```bash
./scripts/install-opencode-config.sh
```

That copies [`examples/opencode.jsonc`](examples/opencode.jsonc) → `~/.config/opencode/opencode.jsonc`  
(skip if the file already exists; `--force` overwrites).

The example **does not pin** a default model. On launch, Manthan OpenCode opens the **model picker** (live `GET /v1/models` — only READY / available workers; sidecar hidden); after you pick, warmup runs. You can also use **`/models`** / the model chip later.

If an existing config still pins `manthan/qwen3.5-4b` (sidecar) or another fixed id and you land on **Big Pickle / OpenCode Zen**:

```bash
./scripts/install-opencode-config.sh --migrate-pins   # keeps API key; strips bad pins
```

Then set the key **in your shell**, not in git:

```bash
export MANTHAN_API_KEY='…'   # ask Vaibhav — same key as Kilo/Manthan
```

Put that export in `~/.zshrc` so VS Code terminals see it.

The example points at the shared GCP API: `http://34.47.151.185:3000/v1`.

## 3. VS Code extension

```bash
chmod +x scripts/opencode-manthan.sh
./scripts/install-vscode.sh
```

- Sets `manthan.binary` to this repo’s `scripts/opencode-manthan.sh`
- Adds `opencode.openTerminal` to `terminal.integrated.commandsToSkipShell` so **Cmd+Esc** is not swallowed when the terminal is focused
- **Reload Window** (`Cmd+Shift+P` → Developer: Reload Window)
- Open a project folder → **Cmd+Esc** (VS Code only)

Optional: `./scripts/install-vscode.sh --replace-stock` if stock OpenCode steals Cmd+Esc.

## 4. Check

Command Palette → **Manthan: Health check**  
If that probe still hits localhost, set VS Code `manthan.baseUrl` to `http://34.47.151.185:3000/v1` (chat itself uses `opencode.jsonc`, not this setting).

Home screen should say **MAN THAN**, show the Manthan model picker, then a warmup loader after you select a model.

## What each piece is

| Thing | Role |
|--------|------|
| `~/.config/opencode/opencode.jsonc` | API URL, models, key via `MANTHAN_API_KEY` |
| `manthan.binary` | Which CLI Cmd+Esc runs (this fork) |
| `manthan.baseUrl` | Health check only |
