#!/usr/bin/env bash
# Build + package + install Manthan extension into VS Code only (not Cursor).
# Usage:
#   ./scripts/install-vscode.sh                 # ship VSIX + install
#   ./scripts/install-vscode.sh --dev           # symlink source (Reload Window)
#   ./scripts/install-vscode.sh --replace-stock # also uninstall sst-dev.opencode
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$ROOT/sdks/vscode"
WRAPPER="$ROOT/scripts/opencode-manthan.sh"
MODE="vsix"
REPLACE_STOCK=0

for arg in "$@"; do
  case "$arg" in
    --dev) MODE="dev" ;;
    --replace-stock) REPLACE_STOCK=1 ;;
    -h|--help)
      sed -n '2,7p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

chmod +x "$WRAPPER"

echo "==> build extension"
cd "$EXT_DIR"
bun install --frozen-lockfile 2>/dev/null || bun install
bun run check-types
node esbuild.js --production

VERSION="$(node -p "require('./package.json').version")"
PUBLISHER="$(node -p "require('./package.json').publisher")"
NAME="$(node -p "require('./package.json').name")"
EXT_ID="${PUBLISHER}.${NAME}"
VSIX_PATH=""

if [[ "$MODE" != "dev" ]]; then
  echo "==> package VSIX"
  rm -f "$EXT_DIR"/*.vsix
  VSIX_PATH="$(node "$ROOT/scripts/package-vscode-vsix.mjs")"
fi

write_vscode_settings() {
  local settings="$1"
  mkdir -p "$(dirname "$settings")"
  [[ -f "$settings" ]] || printf '%s\n' '{}' > "$settings"
  MANTHAN_SETTINGS="$settings" MANTHAN_WRAPPER="$WRAPPER" node <<'NODE'
const fs = require("fs");
const path = process.env.MANTHAN_SETTINGS;
const binary = process.env.MANTHAN_WRAPPER;
const skip = ["opencode.openTerminal", "opencode.openNewTerminal"];
let data;
try {
  data = JSON.parse(fs.readFileSync(path, "utf8"));
} catch {
  console.log("skip settings (JSONC) — set manthan.binary and terminal.integrated.commandsToSkipShell manually");
  process.exit(0);
}
let wrote = false;
const cur = data["manthan.binary"];
if (!cur || cur === "opencode" || String(cur).endsWith("opencode-manthan.sh")) {
  data["manthan.binary"] = binary;
  wrote = true;
  console.log("set manthan.binary →", binary);
} else {
  console.log("keep manthan.binary =", cur);
}
const list = Array.isArray(data["terminal.integrated.commandsToSkipShell"])
  ? data["terminal.integrated.commandsToSkipShell"]
  : [];
const next = [...list];
for (const cmd of skip) {
  if (!next.includes(cmd)) next.push(cmd);
}
if (next.length !== list.length) {
  data["terminal.integrated.commandsToSkipShell"] = next;
  wrote = true;
  console.log("set terminal.integrated.commandsToSkipShell += opencode.openTerminal");
}
if (wrote) fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
NODE
}

ensure_cmd_esc_binding() {
  local kb="$1"
  mkdir -p "$(dirname "$kb")"
  if [[ ! -f "$kb" ]]; then
    printf '%s\n' '[' '  { "key": "cmd+escape", "command": "opencode.openTerminal" }' ']' > "$kb"
    echo "wrote $kb"
    return 0
  fi
  if grep -q 'opencode.openTerminal' "$kb"; then
    echo "keep keybinding in $kb"
    return 0
  fi
  python3 - "$kb" <<'PY'
import pathlib, re, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
entry = '''    {
        "key": "cmd+escape",
        "command": "opencode.openTerminal"
    }'''
if re.search(r'opencode\.openTerminal', text):
    raise SystemExit(0)
m = re.search(r'\[', text)
if not m:
    p.write_text("[\n" + entry + "\n]\n")
    raise SystemExit(0)
i = m.end()
rest = text[i:].lstrip()
insert = "\n" + entry + (",\n" if rest.startswith("{") else "\n")
p.write_text(text[:i] + insert + text[i:])
print("added cmd+escape → opencode.openTerminal")
PY
}

install_into() {
  local ext_home="$1"
  local settings="$2"
  local keybindings="${3:-}"
  local label="$4"
  mkdir -p "$ext_home"
  local target="$ext_home/${EXT_ID}-${VERSION}"
  echo "==> install $label → $target"
  shopt -s nullglob
  local d
  for d in "$ext_home"/${EXT_ID}-*; do
    echo "    remove $d"
    rm -rf "$d"
  done
  shopt -u nullglob
  if [[ "$MODE" == "dev" ]]; then
    ln -sfn "$EXT_DIR" "$target"
  else
    local stage
    stage="$(mktemp -d)"
    unzip -q "$VSIX_PATH" -d "$stage"
    mv "$stage/extension" "$target"
    rm -rf "$stage"
  fi
  write_vscode_settings "$settings"
  if [[ -n "$keybindings" ]]; then
    ensure_cmd_esc_binding "$keybindings"
  fi
}

if [[ -d "$HOME/.vscode" ]] || command -v code >/dev/null 2>&1; then
  install_into \
    "${VSCODE_EXTENSIONS:-$HOME/.vscode/extensions}" \
    "$HOME/Library/Application Support/Code/User/settings.json" \
    "$HOME/Library/Application Support/Code/User/keybindings.json" \
    "VS Code"
  if [[ "$REPLACE_STOCK" -eq 1 ]] && command -v code >/dev/null 2>&1; then
    echo "==> uninstall stock OpenCode (VS Code)"
    code --uninstall-extension sst-dev.opencode 2>/dev/null || true
  fi
  if [[ -n "$VSIX_PATH" ]] && command -v code >/dev/null 2>&1; then
    code --install-extension "$VSIX_PATH" --force >/dev/null 2>&1 || true
  fi
fi

echo
echo "OK  $EXT_ID@$VERSION ($MODE)"
[[ -n "$VSIX_PATH" ]] && echo "    $VSIX_PATH"
echo "Reload Window (Cmd+Shift+P → Developer: Reload Window), then Cmd+Esc"
