#!/usr/bin/env bash
# Copy the example Manthan OpenCode config to ~/.config/opencode/opencode.jsonc
# Usage:
#   ./scripts/install-opencode-config.sh          # copy if missing
#   ./scripts/install-opencode-config.sh --force  # overwrite
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/examples/opencode.jsonc"
DST_DIR="$HOME/.config/opencode"
DST="$DST_DIR/opencode.jsonc"
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help)
      sed -n '2,6p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$SRC" ]]; then
  echo "error: missing $SRC" >&2
  exit 1
fi

mkdir -p "$DST_DIR"
if [[ -f "$DST" && "$FORCE" -ne 1 ]]; then
  echo "keep $DST (already exists — pass --force to overwrite)"
else
  cp "$SRC" "$DST"
  echo "wrote $DST"
fi

echo
echo "Set your key (do not put it in git):"
echo "  export MANTHAN_API_KEY='…'"
echo "Then: ./scripts/install-vscode.sh && Reload Window && Cmd+Esc"
