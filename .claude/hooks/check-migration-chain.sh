#!/usr/bin/env bash
# PostToolUse(Write|Edit|MultiEdit) hook: surface a forked migration chain IMMEDIATELY.
#
# Drizzle's meta/*_snapshot.json files form a single linear chain — each points at its
# parent. They cannot be merged. Two branches that generate from the same base produce two
# snapshots with the same parent, and generation is then jammed for everyone until someone
# hand-repairs it.
#
# .githooks/pre-commit already runs this check, but by commit time the cheap fix (delete
# the migration, rebase, regenerate) has become an interactive rebase of work you have
# already built on. Catching it on the edit that caused it is worth the second or two.
#
# PostToolUse cannot undo the write — the file is already on disk. It reports, and exit 2
# feeds the reason back to the model so the next action is the repair rather than more
# work stacked on a broken chain.
set -uo pipefail

input="$(cat)"

if command -v jq >/dev/null 2>&1; then
	path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
else
	path="$(printf '%s' "$input" |
		grep -oE '"file_path"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"' | head -1 |
		sed -E 's/^"file_path"[[:space:]]*:[[:space:]]*"//; s/"$//')"
fi
[ -n "$path" ] || exit 0

# Only migrations. Everything else is none of this hook's business, and a hook that runs
# a node script on every edit in the repo is a hook someone will disable.
case "$path" in
*/apps/console/lib/db/migrations/*) ;;
*) exit 0 ;;
esac

# Resolve the console dir from the edited path, so this works from any worktree.
console="${path%%/lib/db/migrations/*}"
[ -f "$console/scripts/check-migrations.mjs" ] || exit 0

out="$(cd "$console" && node scripts/check-migrations.mjs 2>&1)" && exit 0

{
	echo "MIGRATION CHAIN BROKEN — caught at edit time, not at commit time."
	echo ""
	printf '%s\n' "$out"
	echo ""
	echo "The drizzle snapshot chain is linear and un-mergeable. If your branch and the"
	echo "target both added a migration: delete yours (the .sql AND its meta snapshot),"
	echo "rebase onto origin/dev, and regenerate so it chains off the latest."
	echo "Fixing it now costs one regeneration; at commit time it costs a rebase."
} >&2
exit 2
