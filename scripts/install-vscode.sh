#!/usr/bin/env bash
# Build + package + install Manthan VS Code extension into local Code.
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

if ! command -v code >/dev/null 2>&1; then
  echo "error: 'code' CLI not on PATH (VS Code → Shell Command: Install 'code' command)" >&2
  exit 1
fi

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
EXT_HOME="${VSCODE_EXTENSIONS:-$HOME/.vscode/extensions}"
TARGET="$EXT_HOME/${EXT_ID}-${VERSION}"
VSIX_PATH=""

# Drop every installed/symlinked Manthan build (CLI --force fails while Code has it loaded)
purge_manthan_ext() {
  shopt -s nullglob
  local d
  for d in "$EXT_HOME"/${EXT_ID}-*; do
    echo "    remove $d"
    rm -rf "$d"
  done
  shopt -u nullglob
}

if [[ "$MODE" == "dev" ]]; then
  echo "==> symlink install → $TARGET"
  purge_manthan_ext
  ln -sfn "$EXT_DIR" "$TARGET"
else
  echo "==> package VSIX"
  rm -f "$EXT_DIR"/*.vsix
  VSIX_PATH="$(node "$ROOT/scripts/package-vscode-vsix.mjs")"
  echo "==> install $VSIX_PATH → $TARGET"
  # Direct extract avoids: "Please restart VS Code before reinstalling Manthan"
  purge_manthan_ext
  STAGE="$(mktemp -d)"
  unzip -q "$VSIX_PATH" -d "$STAGE"
  mkdir -p "$EXT_HOME"
  mv "$STAGE/extension" "$TARGET"
  rm -rf "$STAGE"
  # Best-effort registry sync (ignore restart / in-use errors)
  code --install-extension "$VSIX_PATH" --force >/dev/null 2>&1 || true
fi

if [[ "$REPLACE_STOCK" -eq 1 ]]; then
  echo "==> uninstall stock OpenCode (command-id clash)"
  code --uninstall-extension sst-dev.opencode 2>/dev/null || true
  shopt -s nullglob
  for d in "$EXT_HOME"/sst-dev.opencode-*; do
    echo "    remove $d"
    rm -rf "$d"
  done
  shopt -u nullglob
fi

SETTINGS="$HOME/Library/Application Support/Code/User/settings.json"
if [[ -f "$SETTINGS" ]]; then
  MANTHAN_SETTINGS="$SETTINGS" MANTHAN_WRAPPER="$WRAPPER" node <<'NODE'
const fs = require("fs");
const path = process.env.MANTHAN_SETTINGS;
const binary = process.env.MANTHAN_WRAPPER;
let data;
try {
  data = JSON.parse(fs.readFileSync(path, "utf8"));
} catch {
  console.log("skip settings (JSONC) — set manthan.binary manually to:\n  " + binary);
  process.exit(0);
}
const cur = data["manthan.binary"];
if (!cur || cur === "opencode" || String(cur).endsWith("opencode-manthan.sh")) {
  data["manthan.binary"] = binary;
  fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  console.log("set manthan.binary →", binary);
} else {
  console.log("keep manthan.binary =", cur);
}
NODE
fi

echo
echo "OK  $EXT_ID@$VERSION ($MODE)"
[[ -n "$VSIX_PATH" ]] && echo "    $VSIX_PATH"
echo "Reload Window (Cmd+Shift+P → Developer: Reload Window), then Cmd+Esc"
if code --list-extensions 2>/dev/null | grep -q '^sst-dev.opencode$'; then
  echo "NOTE: sst-dev.opencode still installed — re-run with --replace-stock"
fi
