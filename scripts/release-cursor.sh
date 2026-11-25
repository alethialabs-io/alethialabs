#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# release-cursor.sh — which component commits release-please will NOT see.
#
# WHY THIS EXISTS. release-please (v17, the library behind release-please-action@v5) finds the
# commits since a component's last release by walking `main`'s history newest-first and cutting the
# list at the release commit — by POSITION, not by ancestry (manifest.js `commitsAfterSha`). That
# walk is GraphQL `history`, which lists commits in `git log`'s default order: by commit date, all
# parents. Measured on 2026-11-24: in the walk from 1a9c4c752 the runner-v0.11.0 commit sits at
# index 65 in both the action's log ("Splitting 65 commits") and `git log --format=%H`.
#
# Promotions land on main as MERGE commits of a pinned dev commit (promote.yml), so dev's squash
# commits reach main's history hours after they were committed. A dev commit X committed BEFORE a
# component's release PR merged (commit R), but promoted AFTER it, is not an ancestor of R and yet
# sorts after R in the walk — so release-please cuts it off. It never appears in a release PR, and
# if it was the only change to that component, no release PR is opened at all. The upstream README
# names the assumption: "commits are sorted by merge date" ("Linear git commit history").
#
# It has happened three times already (runner #5344, runner #6566, cli #7237), each found with
# `lost` below run over every past release.
#
#   lost [<ref>]             what release-please will drop at <ref> (default HEAD), per component.
#                            Exit 1 when a dropped commit would have released something.
#   pending <main> <dev>     dev commits touching each component that main does not have yet —
#                            exactly what merging that component's release PR NOW would drop.
#                            Exit 1 when there are any.
#   --self-test              builds a throwaway repo with both orderings; the exit code is the test.
#
# Reads release-please-config.json and .release-please-manifest.json AT <ref>, so it judges the
# branch release-please reads (main), never the checkout's copies (dev's manifest is stale by
# design — docs/releases/README.md).
set -uo pipefail

usage() {
	echo "usage: $0 lost [<ref>] | $0 pending <main-ref> <dev-ref> | $0 --self-test" >&2
	exit 2
}

# ann <level> <message> — a GitHub annotation in Actions, a plain line elsewhere.
ann() {
	if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::$1::$2"; else echo "$1: $2"; fi
}

# packages <ref> — print "<path> <component>" per release-please package at <ref>.
packages() {
	git show "$1:release-please-config.json" |
		jq -r '.packages // {} | to_entries[] | select(.key != ".")
			| "\(.key) \(.value.component // (.key | split("/") | last))"'
}

# releasable <sha> — the commit would move a version: a feat/fix/perf/deps/revert subject, a `!`
# breaking marker, or a BREAKING CHANGE / Release-As footer.
releasable() {
	git log -1 --format=%B "$1" |
		grep -qE '^(feat|fix|perf|deps|revert)(\([^)]*\))?!?:|^[a-z]+(\([^)]*\))?!:|^BREAKING[ -]CHANGE:|^Release-As:'
}

# cmd_lost <ref> — per package: ancestry (what is really new since the tag) minus the walk slice.
cmd_lost() {
	local ref="$1" head tmp pkg comp ver tag r0 rc=0 n c
	head="$(git rev-parse --verify "$ref^{commit}" 2>/dev/null)" || { ann error "cannot resolve $ref"; return 2; }
	tmp="$(mktemp -d)"
	git log --format=%H "$head" >"$tmp/walk"
	while read -r pkg comp; do
		ver="$(git show "$head:.release-please-manifest.json" | jq -r --arg p "$pkg" '.[$p] // empty')"
		tag="$comp-v$ver"
		if [ -z "$ver" ] || ! r0="$(git rev-parse --verify -q "refs/tags/$tag^{commit}")"; then
			ann warning "$pkg: no tag $tag for the manifest's version — cannot place its release cursor."
			continue
		fi
		if ! git merge-base --is-ancestor "$r0" "$head"; then
			ann warning "$pkg: $tag is not an ancestor of $ref — skipped."
			continue
		fi
		git rev-list --no-merges "$r0..$head" -- "$pkg" | sort >"$tmp/new"
		awk -v r="$r0" '$0 == r { exit } { print }' "$tmp/walk" | sort >"$tmp/seen"
		comm -23 "$tmp/new" "$tmp/seen" >"$tmp/lost"
		n="$(grep -c . "$tmp/lost")"
		echo "$pkg ($tag): $(grep -c . "$tmp/new") commit(s) since the release, $n hidden from release-please"
		while read -r c; do
			[ -n "$c" ] || continue
			if releasable "$c"; then
				rc=1
				ann error "$pkg: release-please cannot see $(git log -1 --format='%h %s' "$c") — committed before $tag's release commit, promoted after it. See docs/releases/README.md, 'A release can miss a commit'."
			else
				ann notice "$pkg: hidden from release-please but releases nothing: $(git log -1 --format='%h %s' "$c")"
			fi
		done <"$tmp/lost"
	done < <(packages "$head")
	rm -rf "$tmp"
	return "$rc"
}

# cmd_pending <main> <dev> — dev commits per package that main does not contain.
cmd_pending() {
	local main dev pkg comp rc=0 list
	main="$(git rev-parse --verify "$1^{commit}" 2>/dev/null)" || { ann error "cannot resolve $1"; return 2; }
	dev="$(git rev-parse --verify "$2^{commit}" 2>/dev/null)" || { ann error "cannot resolve $2"; return 2; }
	while read -r pkg comp; do
		list="$(git log --no-merges --format='  %h %cI %s' "$main..$dev" -- "$pkg")"
		if [ -n "$list" ]; then
			rc=1
			echo "$pkg ($comp): dev holds commits main does not — merging the $comp release PR now would drop them:"
			echo "$list"
		else
			echo "$pkg ($comp): nothing pending on dev"
		fi
	done < <(packages "$main")
	return "$rc"
}

# self_test — one throwaway repo, two promotions: a dev commit dated before the release commit is
# hidden, one dated after is not. The exit code is the test.
self_test() {
	local self="$1" pass=0 fail=0 out rc
	ST_DIR="$(mktemp -d)"
	trap 'rm -rf "$ST_DIR"' EXIT
	local dir="$ST_DIR"
	(
		set -e
		cd "$dir"
		export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
		at() { export GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1"; }
		git init -q -b main .
		mkdir -p apps/cli apps/runner
		echo '{"packages":{"apps/cli":{"component":"cli"},"apps/runner":{"component":"runner"}}}' >release-please-config.json
		echo '{"apps/cli":"0.1.0","apps/runner":"0.1.0"}' >.release-please-manifest.json
		echo 1 >apps/cli/a; echo 1 >apps/runner/a
		at 2026-01-01T00:00:00Z; git add -A; git commit -qm 'chore: init'
		git tag cli-v0.1.0; git tag runner-v0.1.0
		git branch dev
		# dev: X touches the CLI at 10:00, Y the runner at 14:00
		git checkout -q dev
		at 2026-01-02T10:00:00Z; echo 2 >apps/cli/a; git commit -qam 'feat(cli): early change'
		at 2026-01-02T14:00:00Z; echo 2 >apps/runner/a; git commit -qam 'fix(runner): late change'
		# main: a CLI release merges at 12:00 (after X was committed, before X is promoted)
		git checkout -q main
		at 2026-01-02T12:00:00Z
		echo '{"apps/cli":"0.1.1","apps/runner":"0.1.0"}' >.release-please-manifest.json
		echo 'notes' >apps/cli/CHANGELOG.md
		git add -A; git commit -qm 'chore(main): release cli 0.1.1'; git tag cli-v0.1.1
		# runner release at 12:30 too, so the runner cursor is placed after the CLI's
		at 2026-01-02T12:30:00Z
		echo '{"apps/cli":"0.1.1","apps/runner":"0.1.1"}' >.release-please-manifest.json
		echo 'notes' >apps/runner/CHANGELOG.md
		git add -A; git commit -qm 'chore(main): release runner 0.1.1'; git tag runner-v0.1.1
		# the promotion carries dev at 16:00
		at 2026-01-02T16:00:00Z; git merge -q --no-ff dev -m 'Merge pull request #1 from o/release/abc'
	) >/dev/null 2>&1 || { echo "  ✗ fixture repo could not be built"; return 1; }

	out="$(cd "$dir" && bash "$self" lost HEAD 2>&1)"; rc=$?
	# X (10:00, before the CLI release at 12:00) is hidden; Y (14:00, after both releases) is seen.
	if [ "$rc" = 1 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  ✗ lost: want exit 1, got $rc"; fi
	if grep -q 'apps/cli.*cannot see .*feat(cli): early change' <<<"$out"; then pass=$((pass + 1)); else
		fail=$((fail + 1)); echo "  ✗ lost: the hidden CLI commit is not named"; fi
	if grep -q 'apps/runner (runner-v0.1.1): 1 commit(s) since the release, 0 hidden' <<<"$out"; then pass=$((pass + 1)); else
		fail=$((fail + 1)); echo "  ✗ lost: the runner commit dated after its release must be seen"; fi

	# The same history BEFORE the promotion: pending names X and Y; with dev promoted, nothing.
	out="$(cd "$dir" && bash "$self" pending HEAD^1 dev 2>&1)"; rc=$?
	if [ "$rc" = 1 ] && grep -q 'early change' <<<"$out" && grep -q 'late change' <<<"$out"; then pass=$((pass + 1)); else
		fail=$((fail + 1)); echo "  ✗ pending: want both dev commits named and exit 1 (rc=$rc)"; fi
	out="$(cd "$dir" && bash "$self" pending HEAD dev 2>&1)"; rc=$?
	if [ "$rc" = 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  ✗ pending: a fully promoted dev must exit 0 (rc=$rc)"; fi

	# Control: re-date X after the CLI release and nothing is hidden.
	(
		set -e
		cd "$dir"
		export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
		git checkout -q -b dev2 cli-v0.1.0
		export GIT_AUTHOR_DATE=2026-01-02T13:00:00Z GIT_COMMITTER_DATE=2026-01-02T13:00:00Z
		echo 3 >apps/cli/a; git commit -qam 'feat(cli): change after the release'
		git checkout -q -b main2 runner-v0.1.1
		export GIT_AUTHOR_DATE=2026-01-02T16:00:00Z GIT_COMMITTER_DATE=2026-01-02T16:00:00Z
		git merge -q --no-ff dev2 -m 'Merge pull request #2 from o/release/def'
	) >/dev/null 2>&1 || { echo "  ✗ control fixture could not be built"; return 1; }
	out="$(cd "$dir" && bash "$self" lost main2 2>&1)"; rc=$?
	if [ "$rc" = 0 ] && grep -q 'apps/cli (cli-v0.1.1): 1 commit(s) since the release, 0 hidden' <<<"$out"; then pass=$((pass + 1)); else
		fail=$((fail + 1)); echo "  ✗ control: a commit dated after the release must be seen (rc=$rc)"; echo "$out" | sed 's/^/    /'; fi

	echo "  ${pass} passed, ${fail} failed"
	[ "$fail" -eq 0 ]
}

case "${1:-}" in
lost) cmd_lost "${2:-HEAD}" ;;
pending) [ $# -eq 3 ] || usage; cmd_pending "$2" "$3" ;;
--self-test)
	_s="$0"
	case "$_s" in /*) ;; *) _s="$PWD/$_s" ;; esac
	self_test "$_s"
	;;
*) usage ;;
esac
