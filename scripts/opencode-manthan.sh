#!/usr/bin/env bash
# Launch the Manthan OpenCode fork (not Homebrew opencode).
set -euo pipefail
# Directory the user invoked from (VS Code workspace / shell cwd) — not the fork repo.
LAUNCH_CWD="$(pwd -P 2>/dev/null || pwd)"
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
ROOT="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"
cd "$ROOT"
export OPENCODE_LAUNCH_CWD="${OPENCODE_LAUNCH_CWD:-$LAUNCH_CWD}"
export PWD="$OPENCODE_LAUNCH_CWD"
exec bun run --cwd packages/opencode --conditions=browser src/index.ts "$@"
