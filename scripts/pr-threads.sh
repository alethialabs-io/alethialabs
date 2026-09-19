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

usage() { echo "usage: $0 <pr-number> [--resolve <thread-id>] | $0 --self-test" >&2; exit 2; }
[ $# -ge 1 ] || usage

# The rendering, held as ONE program so the self-test below exercises the same characters the live
# listing does. A second copy written for the test would verify the copy — which is how a guard ends
# up green about code nobody runs.
render_threads='.[]
	      | select(.isResolved == false)
	      | .comments.nodes[0] as $c
	      | (.comments.nodes | length) as $have
	      | .comments.totalCount as $total
	      | ($c.body | split("\n")) as $lines
	      | ($lines[0] | if length > 140 then .[0:140] + "…" else . end) as $head
	      | (($lines | length) - 1) as $rest
	      | (.comments.nodes[-1]) as $last
	      | "\(.id)\n  \($c.path):\($c.line // $c.originalLine)  by @\($c.author.login)\(if .isOutdated then "  [outdated — still counts]" else "" end)\n  \($head)\(if $rest > 0 then "\n  … +\($rest) more line(s) — open the thread" else "" end)\(if $total > 1 then "\n  ↳ \($total - 1) repl\(if $total == 2 then "y" else "ies" end), last by @\($last.author.login): \($last.body | split("\n")[0][0:110])\(if $total > $have then "  [\($total - $have) not fetched]" else "" end)" else "" end)\n"'

if [ "${1:-}" = "--self-test" ]; then
	fails=0; checks=0
	# `fails` is incremented in THIS shell, never inside `$( … )` — a subshell's counter cannot
	# reach the parent, which is how a bash suite prints FAIL and exits 0.
	thread() { # id, opener body, [reply-author, reply-body]...  → one reviewThreads node
		jq -nc --arg id "$1" --arg body "$2" --argjson replies "$3" \
		  '{id:$id, isResolved:false, isOutdated:false,
		    comments:{totalCount:(1+($replies|length)),
		              nodes:([{path:"a.ts",line:1,originalLine:1,author:{login:"me"},body:$body}] + $replies)}}'
	}
	check() { # label, haystack, needle, want-present(0|1)
		checks=$((checks + 1))
		if [ "$4" = 1 ]; then
			case "$2" in *"$3"*) echo "ok   - $1";; *) fails=$((fails+1)); echo "FAIL - $1: expected to find «$3»" >&2;; esac
		else
			case "$2" in *"$3"*) fails=$((fails+1)); echo "FAIL - $1: expected NOT to find «$3»" >&2;; *) echo "ok   - $1";; esac
		fi
	}

	plain="$(thread T1 "one line" '[]' | jq -sr "$render_threads")"
	check "a single-comment, single-line thread claims no replies" "$plain" "↳" 0
	check "...and does not claim hidden lines"                     "$plain" "more line(s)" 0

	multi="$(thread T2 "first line
second line
third line" '[]' | jq -sr "$render_threads")"
	check "a multi-line opener says how many lines it hid" "$multi" "… +2 more line(s) — open the thread" 1
	check "...and still shows the first line"              "$multi" "first line" 1

	one="$(thread T3 "opener" '[{"author":{"login":"lane"},"body":"leaving this open deliberately"}]' | jq -sr "$render_threads")"
	check "ONE reply is announced, singular, with its author" "$one" "↳ 1 reply, last by @lane" 1
	check "...and its text is shown, not just its existence"  "$one" "leaving this open deliberately" 1

	two="$(thread T4 "opener" '[{"author":{"login":"a"},"body":"x"},{"author":{"login":"b"},"body":"y"}]' | jq -sr "$render_threads")"
	check "TWO replies pluralise and name the LAST speaker" "$two" "↳ 2 replies, last by @b" 1

	long="$(thread T5 "$(printf 'x%.0s' $(seq 1 200))" '[]' | jq -sr "$render_threads")"
	check "an over-long first line is marked as truncated" "$long" "…" 1

	# The page cap is its own elision and must not render as completeness.
	capped="$(jq -nc '{id:"T6",isResolved:false,isOutdated:false,
	           comments:{totalCount:105,nodes:[{path:"a.ts",line:1,originalLine:1,author:{login:"me"},body:"o"},
	                                           {author:{login:"z"},body:"last fetched"}]}}' | jq -sr "$render_threads")"
	check "replies beyond the fetch page are declared, not dropped" "$capped" "[103 not fetched]" 1

	resolved="$(jq -nc '{id:"T7",isResolved:true,isOutdated:false,
	             comments:{totalCount:1,nodes:[{path:"a.ts",line:1,originalLine:1,author:{login:"me"},body:"o"}]}}' | jq -sr "$render_threads")"
	check "a RESOLVED thread is still filtered out" "$resolved" "T7" 0

	# THE QUERY, ASKED OF THE SOURCE — because the fixtures cannot ask it. Every check above feeds
	# the renderer a node that already carries replies, so reverting the fetch to `comments(first:1)`
	# leaves all ten green while the listing goes blind again: the renderer would faithfully report
	# "no replies" about a payload that was never asked for them. That is the precise defect this
	# change exists to remove, and a suite that cannot see it is a suite that would have shipped it.
	# It must match the INVOCATION, not prose about it. The first version of this check grepped the
	# whole file for the pattern text — which appears in this very comment and in the failure message
	# below — so mutating the query rewrote the check's own needle along with it and the check went on
	# passing. A guard that matches its own error string verifies nothing. So the assertion is pinned
	# to the line that also carries the SELECTION SET (`author{login}`), which only the real GraphQL
	# query has and no sentence about it ever will.
	self="${BASH_SOURCE[0]}"
	checks=$((checks + 1))
	if grep -qE 'comments\(first:100\)\{ totalCount nodes \{.*author\{login\}' "$self"; then
		echo "ok   - the query fetches the replies and their total, not just the opener"
	else
		fails=$((fails + 1))
		echo "FAIL - the GraphQL query no longer asks for the replies or their totalCount. The renderer" >&2
		echo "       will faithfully report 'no replies' about a payload it was never given — green, and blind." >&2
	fi

	if [ "$fails" -eq 0 ]; then echo "pr-threads self-test: all $checks checks passed"; exit 0; fi
	echo "pr-threads self-test: $fails of $checks check(s) FAILED" >&2; exit 1
fi

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
#
# A THREAD IS A CONVERSATION, AND THIS LISTING USED TO RENDER ONLY ITS FIRST 140 CHARACTERS.
# It fetched `comments(first:1)` and printed `body | split("\n")[0][0:140]`, so a thread carrying a
# reply — "leaving this open deliberately, here is why" — was indistinguishable from a thread with
# none, and a finding whose consequence sat in its second paragraph read as a one-liner. On
# 2026-09-10 that cost a real decision: a lane declared a thread unresolved ON PURPOSE, said so in
# the thread, and another session resolved it having verified the code and never seen the reply.
# It was not overruled, it was unseen. A second session triaged sixty threads that night deciding
# severity from those 140-character prefixes, and was not bitten only because the openers happened
# to be self-contained.
#
# So the rule this listing now obeys: NEVER RENDER "THERE IS MORE HERE" AS "THAT IS ALL". Both
# elisions are marked — the opener says how many lines it is hiding, and a thread with replies says
# how many and who spoke last. Neither is a substitute for opening the thread; both are there to
# tell you that you must. Resolving a thread you have only seen the first line of is the same act
# as dismissing a review, which is what this gate exists to prevent.
gh api graphql -f query='
  query($o:String!,$n:String!,$pr:Int!){
    repository(owner:$o,name:$n){ pullRequest(number:$pr){
      reviewThreads(first:100){ nodes {
        id isResolved isOutdated
        comments(first:100){ totalCount nodes { path line originalLine author{login} body } } } } } } }' \
	-F o="$owner" -F n="$name" -F pr="$pr" \
	--jq ".data.repository.pullRequest.reviewThreads.nodes | ${render_threads}" \
	| { out="$(cat)"; if [ -z "$out" ]; then echo "no unresolved review threads on #${pr}"; else printf '%s\n' "$out"; fi; }
