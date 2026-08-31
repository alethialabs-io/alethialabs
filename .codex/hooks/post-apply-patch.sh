#!/usr/bin/env bash
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
codex_hook_init
input="$(cat)"
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty')"
[ -n "$cwd" ] || cwd="$PWD"
command="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"

while IFS= read -r path; do
	[ -n "$path" ] || continue
	case "$path" in
		/*) absolute="$path" ;;
		*) absolute="$cwd/$path" ;;
	esac
	payload="$(jq -n --arg path "$absolute" '{tool_name:"Write",tool_input:{file_path:$path}}')"
	if ! reason="$(printf '%s' "$payload" | bash "$CODEX_HOOK_ROOT/.claude/hooks/check-migration-chain.sh" 2>&1 >/dev/null)"; then
		printf '%s\n' "$reason" >&2
		exit 2
	fi
done <<EOF
$(codex_patch_paths "$command")
EOF
