#!/usr/bin/env bash
set -euo pipefail

# Resolve the main checkout and expose the Codex session as the existing lease identity.
codex_hook_init() {
	CODEX_HOOK_ROOT="$(git rev-parse --show-toplevel)"
	CODEX_MAIN_CHECKOUT="$(git worktree list --porcelain |
		awk '/^worktree / { path=$2 } /^branch refs\/heads\/dev$/ { print path; exit }')"
	[ -n "$CODEX_MAIN_CHECKOUT" ] || CODEX_MAIN_CHECKOUT="$CODEX_HOOK_ROOT"
	export CLAUDE_PROJECT_DIR="$CODEX_MAIN_CHECKOUT"
	export CLAUDE_PID="${CODEX_PID:-$PPID}"
	export CLAUDE_CODE_SESSION_ID="${CODEX_SESSION_ID:-${CODEX_THREAD_ID:-}}"
}

# Emit a Codex-native PreToolUse denial while preserving the detailed guard reason.
codex_deny() {
	local reason="$1"
	python3 -c 'import json, sys; print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": sys.argv[1]}}))' "$reason"
}

# Return all paths named by an apply_patch command.
codex_patch_paths() {
	local command="$1"
	printf '%s\n' "$command" | sed -nE 's/^\*\*\* (Add|Update|Delete) File: (.+)$/\2/p'
}
