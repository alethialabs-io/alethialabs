#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
codex_hook_init
input="$(cat)"
message="$(printf '%s' "$input" | bash "$CODEX_HOOK_ROOT/.claude/hooks/session-runtime.sh" 2>&1)"
python3 -c 'import json, sys; print(json.dumps({"systemMessage": sys.argv[1]}))' "$message"
