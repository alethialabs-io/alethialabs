#!/usr/bin/env bash
#
# Lock-guarded drizzle migration generation. drizzle's snapshot journal is a LINEAR,
# un-mergeable chain — two parallel `db:generate` runs (across worktrees / windows) fork
# it and permanently jam generation (see apps/console/scripts/check-migrations.mjs). This
# serializes generation with an atomic mkdir lock (mirrors scripts/compose-up.sh) and
# nudges you to rebase on dev first so your migration chains off the latest.
#
# Wired as apps/console `db:generate`. macOS has no flock, so we use mkdir (portable).
set -euo pipefail

cd "$(dirname "$0")/../apps/console"

LOCK=/tmp/alethia-migrate.lock
if ! mkdir "$LOCK" 2>/dev/null; then
	holder="$(cat "$LOCK/pid" 2>/dev/null || echo "")"
	if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
		echo "⏳ Another db:generate is running (pid $holder). Not racing the migration chain."
		exit 0
	fi
	echo "↻ Reclaiming stale migrate lock (holder pid '${holder:-?}' is gone)."
	rm -rf "$LOCK"
	mkdir "$LOCK"
fi
echo $$ >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

# Warn (don't block) if HEAD isn't on top of origin/dev — a migration generated off a
# stale base forks the chain the moment it merges.
git fetch -q origin dev 2>/dev/null || true
if git rev-parse -q --verify origin/dev >/dev/null 2>&1 &&
	! git merge-base --is-ancestor origin/dev HEAD 2>/dev/null; then
	echo "⚠ origin/dev is not an ancestor of HEAD — rebase on dev before generating"
	echo "  (git rebase origin/dev) so your migration chains off the latest, else it forks."
fi

drizzle-kit generate && node scripts/check-migrations.mjs
