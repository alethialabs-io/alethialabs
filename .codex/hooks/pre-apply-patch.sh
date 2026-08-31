#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
codex_hook_init
input="$(cat)"
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty')"
[ -n "$cwd" ] || cwd="$PWD"
command="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"

paths="$(codex_patch_paths "$command")"
[ -n "$paths" ] || exit 0

while IFS= read -r path; do
	[ -n "$path" ] || continue
	payload="$(jq -n --arg cwd "$cwd" --arg path "$path" '{tool_name:"Write",cwd:$cwd,tool_input:{file_path:$path}}')"
	set +e
	reason="$(printf '%s' "$payload" | bash "$CODEX_HOOK_ROOT/.claude/hooks/guard-worktree.sh" 2>&1 >/dev/null)"
	rc=$?
	set -e
	if [ "$rc" -eq 2 ]; then
		codex_deny "$reason"
		exit 0
	fi
	if [ "$rc" -ne 0 ]; then
		codex_deny "Alethia worktree guard failed closed (exit $rc). $reason"
		exit 0
	fi
done <<EOF
$paths
EOF
