#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# pr-threads.sh — list a PR's UNRESOLVED review threads, and resolve one by id.
#
# WHY THIS EXISTS. `#review-threads-unresolved = 0` keeps a PR out of Mergify's queue until every
# inline review thread is resolved, and RESOLVING IS A SEPARATE ACT FROM FIXING: pushing the fix
# makes a thread *outdated*, not *resolved*, and outdated threads still count. CLAUDE.md tells you
# to resolve the conversation, and before this there was nothing in the tree that could — `gh` has
# no built-in for it, so the instruction named an action nobody could perform. A PR sitting green
# and un-queued forever is almost always this.
#
# DELIBERATELY NOT A BULK RESOLVER. Resolving every thread in one call is indistinguishable from
# dismissing the review, which is the thing the gate exists to prevent. You list what is open, you
# fix it, and you resolve each one you actually addressed.
set -euo pipefail

usage() { echo "usage: $0 <pr-number> [--resolve <thread-id>]" >&2; exit 2; }
[ $# -ge 1 ] || usage
pr="$1"; shift
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
owner="${repo%%/*}"; name="${repo##*/}"

if [ "${1:-}" = "--resolve" ]; then
	[ -n "${2:-}" ] || usage
	target_id="$2"
	thread_state="$(gh api graphql -f query='
	  query($o:String!,$n:String!,$pr:Int!){
	    repository(owner:$o,name:$n){ pullRequest(number:$pr){
	      reviewThreads(first:100){ nodes { id isResolved } }
	    } } }' \
		-F o="$owner" -F n="$name" -F pr="$pr" \
		--jq '.data.repository.pullRequest.reviewThreads.nodes' | \
		jq -r --arg target "$target_id" '.[] | select(.id == $target) | "\(.id)\t\(.isResolved)"')"
	if [ -z "$thread_state" ]; then
		echo "refusing to resolve $target_id: it is not a review thread on #${pr}" >&2
		exit 1
	fi
	if [[ "$thread_state" == *$'\ttrue' ]]; then
		echo "already resolved $target_id"
		exit 0
	fi
	# `isResolved` is echoed back and CHECKED, not assumed: the mutation returns 200 for a thread
	# it did not change, and a silent no-op here would read exactly like success while the gate stayed
	# shut. Membership was checked above so a valid thread id from another PR cannot be mutated.
	out="$(gh api graphql -f query='
	  mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread { id isResolved } } }' \
	  -F id="$target_id" --jq '.data.resolveReviewThread.thread.isResolved')"
	[ "$out" = "true" ] || { echo "resolve did not take effect for $target_id (got isResolved=$out)" >&2; exit 1; }
	echo "resolved $target_id"
	exit 0
fi

# `isResolved: false` covers outdated-but-open too, which is the whole point: `isOutdated` threads
# still count toward Mergify's total, so filtering them out here would hide the common blocker.
gh api graphql -f query='
  query($o:String!,$n:String!,$pr:Int!){
    repository(owner:$o,name:$n){ pullRequest(number:$pr){
      reviewThreads(first:100){ nodes {
        id isResolved isOutdated
        comments(first:1){ nodes { path line originalLine author{login} body } } } } } } }' \
	-F o="$owner" -F n="$name" -F pr="$pr" \
	--jq '.data.repository.pullRequest.reviewThreads.nodes[]
	      | select(.isResolved == false)
	      | .comments.nodes[0] as $c
	      | "\(.id)\n  \($c.path):\($c.line // $c.originalLine)  by @\($c.author.login)\(if .isOutdated then "  [outdated — still counts]" else "" end)\n  \($c.body | split("\n")[0][0:140])\n"' \
	| { out="$(cat)"; if [ -z "$out" ]; then echo "no unresolved review threads on #${pr}"; else printf '%s\n' "$out"; fi; }
