#!/usr/bin/env bash
# shellcheck shell=bash
#
# "Has this branch already landed on dev?" — the question `pnpm wt:prune` has to answer before it
# deletes a worktree.
#
# WHY THIS EXISTS. `--prune` asked it with `git merge-base --is-ancestor <branch> origin/dev` alone,
# which is BLIND to the only way work lands in this repo. Mergify squash-merges every dev PR
# (.mergify.yml), and a squashed branch's commit is never an ancestor of the branch it merged into —
# dev gets a brand-new commit with a different oid and the same tree. So the ancestry test said "not
# merged into origin/dev" for every branch that had, in fact, merged.
#
# The result was not a false delete, it was a total no-op: `--prune` had never once removed anything.
# On 2026-08-02 the pile-up was measured at 30 dead worktrees, 7 of them hydrated with node_modules.
#
# THE RULE. A branch is landed when the ancestry test passes, OR when
#   (a) its newest PR is MERGED, and
#   (b) every commit the branch carries beyond the base appears in that PR.
#
# Clause (b) is the safety property and it is not decoration. A branch whose PR merged but which has
# since grown a NEW local commit has NOT landed, and deleting its tree would destroy that commit —
# which is precisely the shape of the work `--prune` came within one `git worktree remove` of eating
# on 2026-07-27 (22 untracked .tf files, saved only because git refuses without --force). Clause (a)
# alone would have authorised exactly that deletion. So (b) is checked, never assumed.
#
# FAIL-SAFE. No gh on PATH, not authenticated, offline, an unparseable answer — every one of these
# means "not landed". A lookup that could not be completed must never authorise a deletion; the cost
# of a false "not landed" is a worktree that survives one more sweep, and the cost of a false
# "landed" is somebody's work.
#
# Usage (source it):
#   . scripts/lib/wt-landed.sh
#   wt_branch_landed "$worktree" "$branch" "$base"   # 0 = landed · 1 = not
#   # WT_LANDED_WHY carries the human-readable reason either way, for the caller's message.
#
# Self-test: bash scripts/lib/wt-landed-test.sh

# Is <branch> already landed on <base>? Sets WT_LANDED_WHY for the caller's message.
# shellcheck disable=SC2034  # WT_LANDED_WHY is read by callers, not here.
wt_branch_landed() { # <worktree> <branch> <base> → 0 landed, 1 not
	local wt="$1" br="$2" base="$3"
	local pr_line pr state pr_oids missing="" oid
	WT_LANDED_WHY=""

	# The cheap, offline, always-correct case: a real fast-forward or merge commit.
	if git -C "$wt" merge-base --is-ancestor "$br" "$base" 2>/dev/null; then
		WT_LANDED_WHY="merged into $base"
		return 0
	fi

	if ! command -v gh >/dev/null 2>&1; then
		WT_LANDED_WHY="not an ancestor of $base, and gh is not installed — a squash merge is invisible without it"
		return 1
	fi

	# Newest PR wins: a branch can be reused across several PRs, and only the last one describes
	# the commits the tree is holding now.
	pr_line="$(gh pr list --state all --head "$br" --json number,state \
		--jq 'sort_by(.number) | reverse | .[0] | "\(.number) \(.state)"' 2>/dev/null)" || pr_line=""
	# An EMPTY PR list makes jq's `.[0]` null, and the interpolation then yields the two-word
	# string "null null" — not the bare "null" this used to test for. So a branch that never had a
	# PR fell through to the state check below and reported "PR #null is null, not MERGED", which
	# reads like a failed lookup rather than the ordinary "there was never a PR" it actually is.
	# The verdict was right either way (both are "not landed"); the message was misleading, and it
	# was invisible until `branch:prune` started asking about branches that never had one — 12 of
	# them on the first real sweep.
	if [ -z "$pr_line" ] || [ "$pr_line" = "null" ] || [ "${pr_line%% *}" = "null" ]; then
		WT_LANDED_WHY="not an ancestor of $base, and no PR was ever opened for $br"
		return 1
	fi
	pr="${pr_line%% *}"
	state="${pr_line##* }"
	if [ "$state" != "MERGED" ]; then
		WT_LANDED_WHY="PR #$pr is $state, not MERGED"
		return 1
	fi

	pr_oids="$(gh pr view "$pr" --json commits --jq '.commits[].oid' 2>/dev/null)" || pr_oids=""
	if [ -z "$pr_oids" ]; then
		WT_LANDED_WHY="PR #$pr is MERGED but its commit list could not be read — refusing to guess"
		return 1
	fi

	# Every commit the branch carries beyond base must be one the merged PR actually contained.
	# Range it off "$br", not HEAD: in the --prune caller they are the same ref, but reading HEAD
	# would silently answer about whatever the worktree happens to be checked out on, which is the
	# kind of near-miss this function exists to prevent.
	# The loop runs in this shell (heredoc redirect, not a pipe), so `missing` survives it.
	while IFS= read -r oid; do
		[ -n "$oid" ] || continue
		if ! printf '%s\n' "$pr_oids" | grep -qxF "$oid"; then
			missing="$oid"
			break
		fi
	done <<EOF
$(git -C "$wt" rev-list "$base..$br" 2>/dev/null)
EOF

	if [ -n "$missing" ]; then
		WT_LANDED_WHY="PR #$pr merged, but commit $(git -C "$wt" log -1 --format='%h %s' "$missing" 2>/dev/null || echo "${missing:0:9}") is not in it"
		return 1
	fi

	WT_LANDED_WHY="PR #$pr squash-merged"
	return 0
}
