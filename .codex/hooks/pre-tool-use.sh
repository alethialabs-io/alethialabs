#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
codex_hook_init
input="$(cat)"

for guard in guard-worktree.sh guard-compose.sh guard-runtime.sh guard-merge.sh guard-iac.sh; do
	set +e
	reason="$(printf '%s' "$input" | bash "$CODEX_HOOK_ROOT/.claude/hooks/$guard" 2>&1 >/dev/null)"
	rc=$?
	set -e
	if [ "$rc" -eq 2 ]; then
		codex_deny "$reason"
		exit 0
	fi
	if [ "$rc" -ne 0 ]; then
		codex_deny "Alethia guard $guard failed closed (exit $rc). $reason"
		exit 0
	fi
done

set +e
reason="$(printf '%s' "$input" | bash "$CODEX_HOOK_ROOT/.codex/hooks/guard-git-flow.sh" 2>&1 >/dev/null)"
rc=$?
set -e
if [ "$rc" -eq 2 ]; then
	codex_deny "$reason"
	exit 0
fi
if [ "$rc" -ne 0 ]; then
	codex_deny "Alethia guard guard-git-flow.sh failed closed (exit $rc). $reason"
	exit 0
fi
