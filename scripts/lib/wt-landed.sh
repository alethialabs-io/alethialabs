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
#   # Optional, for a caller about to ask about MANY branches (`--prune`, #4622):
#   wt_landed_prefetch "$branch1" "$branch2" ...     # one gh round-trip per 40 branches
#
# Self-test: bash scripts/lib/wt-landed-test.sh

# ── the batched lookup (#4622) ──────────────────────────────────────────────────────────────────
#
# WHY. `--prune` asks wt_branch_landed once per worktree, and each ask cost two serial gh calls
# (`pr list --head`, then `pr view` for the commits): ~0.7s a tree, ~44s over 68 trees, measured
# 2026-09-10 — nearly the whole runtime of a command CLAUDE.md §2 calls routine hygiene.
#
# WHAT. wt_landed_prefetch asks GitHub about every branch in ONE GraphQL request per 40 branches
# (one aliased `pullRequests(headRefName:)` field per branch), and records the answer in
# WT_LANDED_INDEX. wt_branch_landed reads that index before it reaches for gh.
#
# THE SAME QUESTION, NOT A CHEAPER ONE. Each alias asks exactly what `gh pr list --head <br>` did —
# the newest PR on that head, any state — plus that PR's commit oids, which is what `gh pr view`
# supplied. "Newest" is `orderBy: CREATED_AT DESC, first: 1`; the old code sorted by number, and a
# PR's number is allocated when it is created, so the two orders are the same order. Clause (b) is
# then checked by the SAME loop below against those oids — the index changes where the oids come
# from, never whether they are checked.
#
# FAIL-SAFE, BY OMISSION. The index only ever holds a COMPLETE answer. A branch whose alias came back
# null, a PR whose commit list is longer than the one page fetched (totalCount ≠ oids returned), a
# chunk whose request failed or could not be parsed — none of those are recorded, and a branch with
# no entry takes the old per-branch gh path, which fails safe on its own terms. So the worst a broken
# batch can do is cost the old ~0.7s for that branch; it cannot turn a lookup failure into a verdict.
# (The one verdict the index CAN hold without a PR is "this head has no PR at all": `nodes: []` on a
# non-null alias, which is GitHub answering the question, not failing to.)
#
# One line per branch: <branch> TAB <pr number | -> TAB <state | -> TAB <space-separated oids>.
# Git refuses control characters in ref names (git-check-ref-format), so a tab cannot occur in <branch>.
WT_LANDED_INDEX=""

# Record, for each <branch>, the newest PR on that head and its commits — batched. Never fails.
wt_landed_prefetch() { # <branch>... → 0 always; fills WT_LANDED_INDEX with what it could answer
	command -v gh >/dev/null 2>&1 || return 0
	local -a all=() chunk=()
	local b
	for b in "$@"; do
		[ -n "$b" ] || continue
		all+=("$b")
	done
	local start=0 size=40
	while [ "$start" -lt "${#all[@]}" ]; do
		chunk=("${all[@]:start:size}")
		_wt_landed_prefetch_chunk "${chunk[@]}" || true
		start=$((start + size))
	done
	return 0
}

# One GraphQL request for up to 40 branches; appends every COMPLETE answer to WT_LANDED_INDEX.
_wt_landed_prefetch_chunk() { # <branch>... → 1 when the request itself failed
	local -a heads=("$@") args=()
	local i decl="" fields="" out line idx number state total oids n
	for i in "${!heads[@]}"; do
		# Branch names travel as GraphQL VARIABLES, never spliced into the query text, so a name
		# cannot change the query's shape.
		decl="$decl,\$h$i:String!"
		fields="$fields b$i:pullRequests(headRefName:\$h$i,states:[OPEN,CLOSED,MERGED],first:1,orderBy:{field:CREATED_AT,direction:DESC}){nodes{number state commits(first:100){totalCount nodes{commit{oid}}}}}"
		args+=(-f "h$i=${heads[$i]}")
	done
	# `{owner}`/`{repo}` are filled in by gh from the current repository's remote.
	# A null alias (GraphQL errored for that field) is dropped by `select`, so it gets no entry.
	# shellcheck disable=SC2016  # $i/$n below are jq variables, single-quoted on purpose.
	out="$(gh api graphql -F owner='{owner}' -F name='{repo}' "${args[@]}" \
		-f query="query(\$owner:String!,\$name:String!$decl){repository(owner:\$owner,name:\$name){$fields}}" \
		--jq '.data.repository | to_entries[] | select(.value != null) | .key[1:] as $i | .value.nodes[0] as $n
			| if $n == null then "\($i)\t-\t-\t0\t"
			  else "\($i)\t\($n.number)\t\($n.state)\t\($n.commits.totalCount)\t\([$n.commits.nodes[].commit.oid] | join(" "))"
			  end' 2>/dev/null)" || return 1

	while IFS=$'\t' read -r idx number state total oids; do
		# Anything not in the exact expected shape is skipped, which leaves that branch unanswered
		# and therefore on the per-branch path — never on a verdict built from a malformed line.
		case "$idx" in '' | *[!0-9]*) continue ;; esac
		[ "$idx" -lt "${#heads[@]}" ] || continue
		case "$total" in '' | *[!0-9]*) continue ;; esac
		n="$(printf '%s' "$oids" | wc -w | tr -d ' ')"
		# Clause (b) needs EVERY commit of the PR; one page is 100. A longer PR is left unanswered.
		[ "$n" = "$total" ] || continue
		if [ "$number" = "-" ]; then
			[ "$state" = "-" ] || continue
		else
			case "$number" in *[!0-9]*) continue ;; esac
			[ -n "$state" ] || continue
		fi
		line="$(printf '%s\t%s\t%s\t%s' "${heads[$idx]}" "$number" "$state" "$oids")"
		WT_LANDED_INDEX="${WT_LANDED_INDEX:+$WT_LANDED_INDEX
}$line"
	done <<EOF
$out
EOF
	return 0
}

# Print the WT_LANDED_INDEX line for <branch>; 1 when the batch never answered it.
_wt_landed_indexed() { # <branch> → the index line, or exit 1
	[ -n "$WT_LANDED_INDEX" ] || return 1
	# Compared as a plain string field, so a branch name is never read as a pattern. (`awk -v` does
	# expand backslash escapes, but git-check-ref-format refuses a backslash in a ref name.)
	printf '%s\n' "$WT_LANDED_INDEX" | awk -F'\t' -v b="$1" '$1 == b { print; found = 1; exit } END { exit !found }'
}

# Is <branch> already landed on <base>? Sets WT_LANDED_WHY for the caller's message.
# shellcheck disable=SC2034  # WT_LANDED_WHY is read by callers, not here.
wt_branch_landed() { # <worktree> <branch> <base> → 0 landed, 1 not
	local wt="$1" br="$2" base="$3"
	local pr_line pr state pr_oids missing="" oid
	WT_LANDED_WHY=""

	# How much does this branch carry that base does not? Asked FIRST, because the ancestry test
	# below cannot tell the two zero-ahead shapes apart and used to resolve both as "landed".
	local ahead
	ahead="$(git -C "$wt" rev-list --count "$base..$br" 2>/dev/null)" || ahead=""
	if [ -z "$ahead" ]; then
		WT_LANDED_WHY="could not compare $br against $base"
		return 1
	fi

	# The offline shortcut, now guarded. `--is-ancestor` is true for a fast-forwarded branch AND
	# for a brand-new one that has not committed yet — both carry zero commits beyond base, and
	# git cannot distinguish them: after a fast-forward the branch tip IS the base tip, which is
	# exactly where `pnpm wt` puts a fresh branch. Reporting both as "merged into $base" is how a
	# worktree could be created and swept seconds later (#1986) — observed, on this session's own
	# tree, mid-task.
	#
	# Squash merges make that worse than a corner case. Every dev PR lands as a squash
	# (.mergify.yml), and a squashed branch is never an ancestor of dev — so in this repo
	# `--is-ancestor` is almost never true for work that really landed, and this shortcut was in
	# practice a fresh-branch detector wearing a "landed" label.
	#
	# So ambiguity is resolved by the PR rather than guessed: a zero-ahead branch falls through to
	# the lookup below, where a real fast-forward still shows a MERGED PR and still reports landed,
	# while a fresh branch has no PR and is kept. Only a branch that genuinely carries commits into
	# base takes the offline path.
	if [ "$ahead" != "0" ] && git -C "$wt" merge-base --is-ancestor "$br" "$base" 2>/dev/null; then
		WT_LANDED_WHY="merged into $base"
		return 0
	fi

	if ! command -v gh >/dev/null 2>&1; then
		WT_LANDED_WHY="not an ancestor of $base, and gh is not installed — a squash merge is invisible without it"
		return 1
	fi

	# Newest PR wins: a branch can be reused across several PRs, and only the last one describes
	# the commits the tree is holding now.
	# The batched answer is used when wt_landed_prefetch recorded one; otherwise one gh call here.
	local indexed="" indexed_oids=""
	if indexed="$(_wt_landed_indexed "$br")"; then
		local _ix_br _ix_num _ix_state
		IFS=$'\t' read -r _ix_br _ix_num _ix_state indexed_oids <<<"$indexed"
		if [ "$_ix_num" = "-" ]; then pr_line=""; else pr_line="$_ix_num $_ix_state"; fi
	else
		indexed=""
		pr_line="$(gh pr list --state all --head "$br" --json number,state \
			--jq 'sort_by(.number) | reverse | .[0] | "\(.number) \(.state)"' 2>/dev/null)" || pr_line=""
	fi
	# An EMPTY PR list makes jq's `.[0]` null, and the interpolation then yields the two-word
	# string "null null" — not the bare "null" this used to test for. So a branch that never had a
	# PR fell through to the state check below and reported "PR #null is null, not MERGED", which
	# reads like a failed lookup rather than the ordinary "there was never a PR" it actually is.
	# The verdict was right either way (both are "not landed"); the message was misleading, and it
	# was invisible until `branch:prune` started asking about branches that never had one — 12 of
	# them on the first real sweep.
	if [ -z "$pr_line" ] || [ "$pr_line" = "null" ] || [ "${pr_line%% *}" = "null" ]; then
		# Separate the two no-PR shapes in the MESSAGE, because an operator reading a sweep needs to
		# tell "work in progress that never opened a PR" from "this tree was created minutes ago and
		# has nothing in it yet". The verdict is the same — keep it — but "not an ancestor of dev"
		# is simply false for a fresh branch, and printing it was half of why #1986 read as correct.
		if [ "$ahead" = "0" ]; then
			WT_LANDED_WHY="no commits beyond $base yet and no PR — a fresh branch, nothing to land"
		else
			WT_LANDED_WHY="not an ancestor of $base, and no PR was ever opened for $br"
		fi
		return 1
	fi
	pr="${pr_line%% *}"
	state="${pr_line##* }"
	if [ "$state" != "MERGED" ]; then
		WT_LANDED_WHY="PR #$pr is $state, not MERGED"
		return 1
	fi

	if [ -n "$indexed" ]; then
		# One oid per line, the shape `gh pr view --jq '.commits[].oid'` prints and the loop reads.
		pr_oids="$(printf '%s\n' "$indexed_oids" | tr ' ' '\n' | grep . || true)"
	else
		pr_oids="$(gh pr view "$pr" --json commits --jq '.commits[].oid' 2>/dev/null)" || pr_oids=""
	fi
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
