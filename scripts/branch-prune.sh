#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# `pnpm branch:prune` — delete LOCAL branches whose work has already landed on dev.
#
# WHY THIS EXISTS. `pnpm wt:prune` sweeps landed worktrees; nothing swept the branches those
# worktrees left behind. Measured on 2026-08-04: 146 local branches against 11 remote and 35
# worktrees — every landed feature branch since the repo started, still sitting there.
#
# WHY `git branch -d` IS NOT THE ANSWER. It is the same trap that made `wt:prune` a total no-op
# for its whole life (scripts/lib/wt-landed.sh explains it at length): Mergify SQUASH-merges every
# dev PR, so a landed branch's commit is never an ancestor of dev — dev gets a brand-new oid
# carrying the same tree. `-d` asks precisely that ancestry question, so it refuses every branch
# that has in fact landed. `-D` answers by not asking, which is how you delete unlanded work.
#
# So this uses `-D`, and earns it: the delete is gated on wt_branch_landed(), whose clause (b)
# proves every commit the branch carries beyond the base is one the merged PR actually contained.
# THAT is what makes -D safe here. Do not "fix" it back to -d — it would silently stop working.
#
# THE ASYMMETRY. A false "landed" is somebody's work deleted. A false "not landed" is one
# surviving branch. Every uncertain case therefore resolves to KEEP, loudly.
#
# COST. The cheap offline ancestry test runs first and short-circuits real merge commits. Only a
# non-ancestor branch pays ~2 `gh` calls, so a full sweep of ~150 branches takes a few minutes and
# sits well inside the 5000/hr authenticated limit.
#
# Usage:
#   pnpm branch:prune --dry-run   # report only; removes nothing
#   pnpm branch:prune             # delete the landed ones
#
# Self-test: bash scripts/lib/branch-prune-test.sh
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
. "$PWD/scripts/lib/wt-landed.sh"

dry=0
[ "${1:-}" = "--dry-run" ] && dry=1
case "${1:-}" in
-h | --help)
	sed -n '5,30p' "$0"
	exit 0
	;;
esac

git fetch -q origin dev 2>/dev/null || true
base="origin/dev"
git rev-parse --verify -q "$base" >/dev/null 2>&1 || base="dev"

# Branches that are never candidates, whatever their state. `dev` is the base; `main` and
# `staging` are the promotion train; the current branch cannot be deleted from under itself.
current="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
protected=" dev main staging $current "

# Every branch checked out in SOME worktree, mapped to the worktree holding it. git already
# refuses to delete these, but refusing with a name is the difference between a message someone
# can act on and one they have to go investigate.
declare_worktree_branches() {
	git worktree list --porcelain | awk '
		/^worktree /{ wt = $2 }
		/^branch /  { sub("refs/heads/", "", $2); print $2 "\t" wt }
	'
}
wt_map="$(declare_worktree_branches)"

# Branches with an OPEN PR — one query, not one per branch.
open_prs=""
if command -v gh >/dev/null 2>&1; then
	open_prs="$(gh pr list --state open --limit 200 --json headRefName --jq '.[].headRefName' 2>/dev/null || true)"
fi

removed=0
kept=0

while IFS= read -r br; do
	[ -n "$br" ] || continue

	case "$protected" in *" $br "*)
		echo "  skip  $br — protected"
		kept=$((kept + 1))
		continue
		;;
	esac

	held="$(printf '%s\n' "$wt_map" | awk -F'\t' -v b="$br" '$1 == b { print $2; exit }')"
	if [ -n "$held" ]; then
		echo "  skip  $br — checked out in $held"
		kept=$((kept + 1))
		continue
	fi

	if [ -n "$open_prs" ] && printf '%s\n' "$open_prs" | grep -qxF "$br"; then
		echo "  skip  $br — has an OPEN PR"
		kept=$((kept + 1))
		continue
	fi

	# The predicate wt:prune deletes worktrees on. Reused verbatim: it ranges off "$br" rather
	# than HEAD and uses its directory argument only for `git -C`, so a bare branch with no
	# worktree is answered correctly.
	if ! wt_branch_landed "$PWD" "$br" "$base"; then
		echo "  skip  $br — ${WT_LANDED_WHY}"
		kept=$((kept + 1))
		continue
	fi

	if [ "$dry" = 1 ]; then
		echo "  WOULD rm  $br — ${WT_LANDED_WHY}"
		removed=$((removed + 1))
		continue
	fi

	# Print the sha before deleting: a landed branch is recoverable from the PR, but an operator
	# reading this log afterwards should not have to go find it.
	sha="$(git rev-parse --short "$br" 2>/dev/null || echo '???????')"
	if git branch -D "$br" >/dev/null 2>&1; then
		echo "  rm    $br ($sha) — ${WT_LANDED_WHY}"
		removed=$((removed + 1))
	else
		echo "  skip  $br — git refused to delete it"
		kept=$((kept + 1))
	fi
done <<EOF
$(git for-each-ref --format='%(refname:short)' refs/heads/)
EOF

echo ""
if [ "$dry" = 1 ]; then
	echo "✓ dry run: would remove $removed, keep $kept. Nothing was touched."
else
	echo "✓ removed $removed, kept $kept."
fi
