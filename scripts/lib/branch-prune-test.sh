#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Acceptance test for `scripts/branch-prune.sh`.
#
# Drives the REAL script against a throwaway repo with a stub `gh` on PATH, so every branch shape
# the board produces is exercised without touching the network or the real tree.
#
# Scope: this tests the SCRIPT's own rules — protected branches, worktree-held branches, open PRs,
# and --dry-run. The landed predicate underneath it is `wt_branch_landed`, which has its own table
# in scripts/lib/wt-landed-test.sh and is not re-tested here.
#
# The rows that matter are the KEPT ones. A branch wrongly deleted is somebody's work; a branch
# wrongly kept is one surviving ref. The asymmetry is the whole design, and rows 1-5 are all of
# the first kind.
#
# Usage: bash scripts/lib/branch-prune-test.sh
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1
SRC="$PWD"

fails=0
pass() { echo "ok   - $1"; }
fail() {
	echo "FAIL - $1" >&2
	fails=$((fails + 1))
}
expect_absent() { # <branch> <name>   — the branch must NOT survive
	if git -C "$R" show-ref -q --verify "refs/heads/$1"; then fail "$2 (branch still present)"; else pass "$2"; fi
}
expect_present() { # <branch> <name>  — the branch MUST survive
	if git -C "$R" show-ref -q --verify "refs/heads/$1"; then pass "$2"; else fail "$2 (branch was DELETED)"; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── a throwaway repo carrying a copy of the script under test ───────────────────────────────────
R="$TMP/repo"
git init -q -b dev "$R"
git -C "$R" config user.email t@t
git -C "$R" config user.name t
mkdir -p "$R/scripts/lib"
cp "$SRC/scripts/branch-prune.sh" "$R/scripts/branch-prune.sh"
cp "$SRC/scripts/lib/wt-landed.sh" "$R/scripts/lib/wt-landed.sh"

seed() { echo "$1" >"$R/$1.txt" && git -C "$R" add -A && git -C "$R" commit -q -m "$1"; }
seed base

# Fork every branch off a SHA, not a `devbase` branch. A helper branch pointing at dev's tip is
# itself an ancestor of dev, so the sweep legitimately deletes it — and every later `mk` then
# fails to resolve it, which reads as a bogus test failure rather than the harness bug it is.
DEVBASE="$(git -C "$R" rev-parse dev)"

mk() { # <branch> <commit-subject>...
	local br="$1"
	shift
	git -C "$R" checkout -q -B "$br" "$DEVBASE"
	for s in "$@"; do seed "$s"; done
	git -C "$R" checkout -q dev
}

mk squashed feature-a            # PR merged as a squash → must be DELETED
mk still-open feature-b          # PR open → kept
mk merged-plus-new feature-c new # PR merged, then a new local commit → kept
mk in-worktree feature-d         # checked out elsewhere → kept
mk main-lookalike feature-e      # ordinary branch, deleted; guards the protected match
git -C "$R" branch staging "$DEVBASE"
git -C "$R" branch main "$DEVBASE"

# A branch that is genuinely checked out in another worktree.
git -C "$R" worktree add -q "$TMP/held" in-worktree 2>/dev/null

oid() { git -C "$R" rev-parse "$1"; }

# ── stub gh: the two calls wt_branch_landed makes, plus the one the script makes itself ─────────
mkdir -p "$TMP/bin"
cat >"$TMP/bin/gh" <<STUB
#!/usr/bin/env bash
if [ "\$1" = "pr" ] && [ "\$2" = "list" ]; then
	# The script's own one-shot query for OPEN PRs (no --head argument).
	case " \$* " in *" --state open "*) echo "still-open"; exit 0 ;; esac
	for a in "\$@"; do case "\$prev" in --head) br="\$a" ;; esac; prev="\$a"; done
	case "\$br" in
	squashed)        echo "201 MERGED" ;;
	still-open)      echo "202 OPEN" ;;
	merged-plus-new) echo "203 MERGED" ;;
	in-worktree)     echo "204 MERGED" ;;
	main-lookalike)  echo "205 MERGED" ;;
	*)               echo "" ;;
	esac
	exit 0
fi
if [ "\$1" = "pr" ] && [ "\$2" = "view" ]; then
	case "\$3" in
	201) echo "$(oid squashed)" ;;
	203) echo "$(oid merged-plus-new~1)" ;;   # the PR held only the FIRST commit
	204) echo "$(oid in-worktree)" ;;
	205) echo "$(oid main-lookalike)" ;;
	*)   echo "" ;;
	esac
	exit 0
fi
exit 1
STUB
chmod +x "$TMP/bin/gh"

run() { (cd "$R" && PATH="$TMP/bin:$PATH" bash scripts/branch-prune.sh "$@" 2>&1); }

# ── --dry-run must not touch anything ───────────────────────────────────────────────────────────
dry="$(run --dry-run)"
expect_present squashed "dry run removes nothing, even the landed branch"
case "$dry" in *"WOULD rm  squashed"*) pass "dry run names the branch it would remove" ;;
*) fail "dry run did not report 'WOULD rm squashed'" ;; esac
case "$dry" in *"Nothing was touched"*) pass "dry run says so" ;; *) fail "dry run summary missing" ;; esac

# ── the real sweep ──────────────────────────────────────────────────────────────────────────────
out="$(run)"

expect_present dev "dev is protected"
expect_present main "main is protected"
expect_present staging "staging is protected"
expect_present still-open "a branch with an OPEN PR is kept"
expect_present merged-plus-new "merged PR + a NEW local commit is kept — the work would be lost"
expect_present in-worktree "a branch checked out in a worktree is kept"
expect_absent squashed "a squash-merged branch IS deleted — the whole point"
expect_absent main-lookalike "an ordinary landed branch is deleted (protected match is exact)"

case "$out" in *"checked out in"*) pass "the worktree skip names the holding worktree" ;;
*) fail "worktree skip did not name the holder" ;; esac
case "$out" in *"has an OPEN PR"*) pass "the open-PR skip says why" ;;
*) fail "open-PR skip did not say why" ;; esac

# ── fail-safe: no gh at all → nothing may be deleted ────────────────────────────────────────────
mk lonely feature-f
mkdir -p "$TMP/nogh"
ln -sf "$(command -v git)" "$TMP/nogh/git"
ln -sf "$(command -v awk)" "$TMP/nogh/awk"
ln -sf "$(command -v grep)" "$TMP/nogh/grep"
(cd "$R" && PATH="$TMP/nogh" bash scripts/branch-prune.sh >/dev/null 2>&1)
expect_present lonely "no gh on PATH → nothing is deleted on a failed lookup"

echo ""
if [ "$fails" = 0 ]; then
	echo "✓ all rows passed"
else
	echo "✗ $fails row(s) failed" >&2
	exit 1
fi
