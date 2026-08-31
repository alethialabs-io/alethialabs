#!/usr/bin/env bash
set -euo pipefail

input="$(cat)"
command="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"
[ -n "$command" ] || exit 0

# Search and print commands are inspecting policy text, not pushing to a remote.
printf '%s' "$command" | grep -Eq '^[[:space:]]*(grep|egrep|fgrep|rg|sed|awk|cat|echo|printf|head|tail|jq|find)\b' && exit 0

# Keep the pre-tool rule narrow. The repository pre-push hook remains authoritative for implicit
# current-branch pushes and any ref spelling this textual guard cannot resolve safely.
if printf '%s' "$command" | grep -Eq '(^|[^[:alnum:]_-])git([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+)?([[:space:]]+[^[:space:]]+)*[[:space:]]+push\b[^&;|]*[[:space:]](dev|staging|main)([[:space:]]|$)'; then
	echo "BLOCKED: direct pushes to protected branches (dev, staging, main) are not allowed." >&2
	echo "  Push a feature branch and open a PR into dev; the repository pre-push hook enforces the same rule." >&2
	exit 2
fi
