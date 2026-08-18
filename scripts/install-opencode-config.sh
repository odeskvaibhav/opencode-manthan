#!/usr/bin/env bash
# Copy the example Manthan OpenCode config to ~/.config/opencode/opencode.jsonc
# Usage:
#   ./scripts/install-opencode-config.sh          # copy if missing
#   ./scripts/install-opencode-config.sh --force  # overwrite (replaces keys with {env:MANTHAN_API_KEY})
#   ./scripts/install-opencode-config.sh --migrate-pins  # strip top-level/agent model pins + sidecar ids
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/examples/opencode.jsonc"
DST_DIR="$HOME/.config/opencode"
DST="$DST_DIR/opencode.jsonc"
FORCE=0
MIGRATE=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --migrate-pins) MIGRATE=1 ;;
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

if [[ ! -f "$SRC" ]]; then
  echo "error: missing $SRC" >&2
  exit 1
fi

mkdir -p "$DST_DIR"

migrate_pins() {
  local file="$1"
  python3 - "$file" <<'PY'
from pathlib import Path
import re, sys
path = Path(sys.argv[1])
text = path.read_text()
# Drop top-level + agent "model": "manthan/…" pins (sidecar pins break picker → Zen/Big Pickle).
text2 = re.sub(r'\n\s*"model"\s*:\s*"manthan/[^"]+"\s*,', '\n', text)
# Drop known sidecar helper model objects from provider.models
for key in ("qwen3.5-4b", "qwen3.5-4b-sidecar"):
    m = re.search(rf'\n(\s*)"{re.escape(key)}"\s*:\s*\{{', text2)
    if not m:
        continue
    start = m.start()
    i = m.end() - 1
    depth = 0
    j = i
    while j < len(text2):
        c = text2[j]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                j += 1
                break
        j += 1
    end = j
    if end < len(text2) and text2[end] == ",":
        end += 1
    text2 = text2[:start] + text2[end:]
if "No pinned default model" not in text2.splitlines()[0:6]:
    text2 = re.sub(
        r"// Default model:.*\n",
        "// No pinned default model — pick via /models on launch (sidecar ids hidden).\n",
        text2,
        count=1,
    )
path.write_text(text2)
print(f"migrated pins in {path}")
PY
}

if [[ "$MIGRATE" -eq 1 ]]; then
  if [[ ! -f "$DST" ]]; then
    echo "error: missing $DST (nothing to migrate)" >&2
    exit 1
  fi
  migrate_pins "$DST"
elif [[ -f "$DST" && "$FORCE" -ne 1 ]]; then
  echo "keep $DST (already exists — pass --force to overwrite, or --migrate-pins to strip model pins)"
else
  cp "$SRC" "$DST"
  echo "wrote $DST"
fi

echo
echo "Set your key (do not put it in git):"
echo "  export MANTHAN_API_KEY='…'"
echo "Then: ./scripts/install-vscode.sh && Reload Window && Cmd+Esc"
echo "On launch: Manthan model picker opens → pick Laguna/Qwen/… → warmup greeting runs."
echo "Do not pin \"model\": \"manthan/qwen3.5-4b\" (sidecar — hidden; falls back to Zen/Big Pickle)."
