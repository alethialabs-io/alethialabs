#!/usr/bin/env bash
#
# One-worktree-per-instance helper (see CLAUDE.md → Local stack). Makes the compliant
# path a single command so the enforcement hooks aren't painful:
#
#   pnpm wt <name>            create ../wt-<name> on feat/<name> off dev, print next steps
#   pnpm wt <name> --install  … and run `pnpm install` in the new worktree
#   pnpm wt:ls                list worktrees (alias → git worktree list)
#   pnpm wt:rm <name>         remove ../wt-<name>
#
# Worktrees are sibling dirs of app/ named `wt-<name>`; the main app/ checkout stays on
# the integration branch `dev` and never holds feature work.
set -euo pipefail

cd "$(dirname "$0")/.." # the invoking worktree's top-level

usage() {
	echo "Usage: pnpm wt <name> [--install]   |   pnpm wt:ls   |   pnpm wt:rm <name>" >&2
	exit 1
}

# `pnpm wt:rm <name>` routes here as: worktree.sh --remove <name>
if [ "${1:-}" = "--remove" ]; then
	name="${2:-}"
	[ -n "$name" ] || usage
	name="${name#feat/}"
	dir="../wt-${name}"
	if git worktree remove "$dir" 2>/dev/null; then
		echo "✓ removed $dir"
	else
		echo "✗ couldn't remove $dir — it may have uncommitted changes." >&2
		echo "  Inspect it, or force: git worktree remove --force $dir" >&2
		exit 1
	fi
	exit 0
fi

name="${1:-}"
[ -n "$name" ] || usage
name="${name#feat/}" # tolerate `pnpm wt feat/foo`
branch="feat/${name}"
dir="../wt-${name}"
install=0
[ "${2:-}" = "--install" ] && install=1

if [ -d "$dir" ]; then
	echo "↳ $dir already exists (branch $(git -C "$dir" rev-parse --abbrev-ref HEAD)). Reusing it."
else
	git fetch -q origin dev 2>/dev/null || true
	base="origin/dev"
	git rev-parse --verify -q "$base" >/dev/null 2>&1 || base="dev"
	if git show-ref --verify -q "refs/heads/$branch" ||
		git show-ref --verify -q "refs/remotes/origin/$branch"; then
		git worktree add "$dir" "$branch"
	else
		git worktree add "$dir" -b "$branch" "$base"
	fi
	echo "✓ created $dir on $branch (off $base)"
fi

# Suggest a free console port (3000, 3100, 3200, …) so each worktree runs its own dev:up.
port=3000
while lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do port=$((port + 100)); done

abs="$(cd "$dir" && pwd)"
echo ""
echo "Next:"
echo "  cd $abs"
if [ "$install" = 1 ]; then
	(cd "$dir" && pnpm install)
else
	echo "  pnpm install             # node_modules aren't shared across worktrees"
fi
echo "  PORT=$port pnpm dev:up   # a free console port (each worktree = its own console)"
echo ""
echo "Commit here (not in app/); push; open a PR into dev."
