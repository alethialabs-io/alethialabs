#!/usr/bin/env bash
#
# Acceptance test for wt_branch_landed() — the predicate `pnpm wt:prune` deletes worktrees on.
#
# Drives it against a REAL throwaway repo with a stub `gh` on PATH, so every branch shape the
# real board produces is exercised without touching the network or the real tree.
#
# The rows that matter are the LANDED=no ones. A false "landed" is somebody's work deleted;
# a false "not landed" is one surviving worktree. The asymmetry is the whole design.
#
# Usage: bash scripts/lib/wt-landed-test.sh
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1
. "$PWD/scripts/lib/wt-landed.sh"

fails=0
pass() { echo "ok   - $1"; }
fail() {
	echo "FAIL - $1" >&2
	fails=$((fails + 1))
}
expect() { # <want> <got> <name>
	if [ "$1" = "$2" ]; then pass "$3"; else fail "$3: want '$1' got '$2'  (why: ${WT_LANDED_WHY:-})"; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── a throwaway repo: base branch `dev`, plus one branch per shape under test ────────────────────
R="$TMP/repo"
git init -q -b dev "$R"
git -C "$R" config user.email t@t
git -C "$R" config user.name t
seed() { echo "$1" >"$R/$1.txt" && git -C "$R" add -A && git -C "$R" commit -q -m "$1"; }
seed base

# `dev` stands in for origin/dev. Every branch below forks from it.
git -C "$R" branch -f devbase dev

mk() { # <branch> <commit-subject>...
	local br="$1"
	shift
	git -C "$R" checkout -q -B "$br" devbase
	for s in "$@"; do seed "$s"; done
	git -C "$R" checkout -q dev
}

mk squashed feature-a           # merged as a squash → NOT an ancestor of dev
mk still-open feature-b         # PR open
mk no-pr feature-c              # never had a PR (gh prints nothing)
mk no-pr-null feature-g         # never had a PR (gh prints jq's "null null" — the real shape)
mk merged-plus-new feature-d extra # PR merged, then a NEW commit was added
mk unreadable feature-e         # PR merged but `gh pr view` fails

# A truly fast-forwarded branch IS an ancestor — the offline path must still work.
git -C "$R" checkout -q -B ff devbase
seed feature-ff
git -C "$R" checkout -q dev
git -C "$R" merge -q --ff-only ff

# #1986: a brand-new branch, exactly as `pnpm wt <name>` leaves it — forked from the base, not one
# commit made yet. It is an ancestor of the base for the trivial reason that it IS the base, and the
# old code therefore called it "merged into dev" and authorised `git worktree remove`. This row is
# the regression: a fresh tree must never be classified as landed. Observed for real on 2026-08-05,
# on a worktree that had been created minutes earlier and was in active use.
git -C "$R" branch -f fresh dev

oid() { git -C "$R" rev-parse "$1"; }

# ── stub gh ─────────────────────────────────────────────────────────────────────────────────────
# Mimics only the two calls wt_branch_landed makes. `unreadable` returns MERGED from `pr list`
# and then fails `pr view`, which is the offline/rate-limited shape.
mkdir -p "$TMP/bin"
cat >"$TMP/bin/gh" <<STUB
#!/usr/bin/env bash
if [ "\$1" = "pr" ] && [ "\$2" = "list" ]; then
	for a in "\$@"; do case "\$prev" in --head) br="\$a" ;; esac; prev="\$a"; done
	case "\$br" in
	squashed)        echo "101 MERGED" ;;
	still-open)      echo "102 OPEN" ;;
	no-pr)           echo "" ;;
	no-pr-null)      echo "null null" ;;
	merged-plus-new) echo "104 MERGED" ;;
	unreadable)      echo "105 MERGED" ;;
	# A branch that fast-forwarded into dev got there through a PR like anything else, so the
	# fixture gives it one. It is what keeps ff resolving as LANDED now that a zero-ahead branch
	# is decided by the PR rather than by ancestry alone (#1986).
	# (No backticks in this heredoc: it is unquoted, so they would be command-substituted.)
	ff)              echo "106 MERGED" ;;
	*)               echo "" ;;
	esac
	exit 0
fi
if [ "\$1" = "pr" ] && [ "\$2" = "view" ]; then
	case "\$3" in
	101) echo "$(oid squashed)" ;;
	104) echo "$(oid merged-plus-new~1)" ;;   # the PR contained only the FIRST commit
	105) exit 1 ;;                            # lookup fails
	106) echo "$(oid ff)" ;;
	*)   echo "" ;;
	esac
	exit 0
fi
exit 1
STUB
chmod +x "$TMP/bin/gh"

check() { # <branch> → prints yes/no
	if PATH="$TMP/bin:$PATH" wt_branch_landed "$R" "$1" dev; then echo yes; else echo no; fi
}

# ── the table ───────────────────────────────────────────────────────────────────────────────────
expect yes "$(check ff)" "a real fast-forward is landed (offline path)"
expect yes "$(check squashed)" "a squash-merged branch is landed — the whole point"
expect no "$(check still-open)" "an OPEN PR is not landed"
expect no "$(check no-pr)" "a branch with no PR is not landed"
expect no "$(check no-pr-null)" "an empty PR list (jq renders it \"null null\") is not landed"
# The REASON matters as much as the verdict here: both spellings return "not landed", so only the
# message distinguishes "there was never a PR" from "the lookup failed". Read it inside the
# subshell — WT_LANDED_WHY does not survive a command substitution.
why() { PATH="$TMP/bin:$PATH" wt_branch_landed "$R" "$1" dev >/dev/null 2>&1; echo "${WT_LANDED_WHY:-}"; }
case "$(why no-pr-null)" in *"no PR was ever opened"*) pass "...and says so, rather than 'PR #null is null'" ;;
*) fail "no-PR reason misreported as: $(why no-pr-null)" ;; esac
expect no "$(check merged-plus-new)" "merged PR + a NEW local commit is NOT landed"
expect no "$(check unreadable)" "an unreadable commit list is not landed"

# ── #1986: the fresh worktree ───────────────────────────────────────────────────────────────────
# The row this whole change exists for. A zero-commit branch is an ancestor of the base trivially,
# and calling that "landed" deleted a tree that was minutes old and in use.
expect no "$(check fresh)" "a brand-new branch with no commits is NOT landed (#1986)"
case "$(why fresh)" in *"fresh branch"*) pass "...and says it is a fresh branch, not 'merged into dev'" ;;
*) fail "fresh-branch reason misreported as: $(why fresh)" ;; esac
# The guard must be about having no COMMITS, not about having no PR: a fresh branch that somehow
# has a merged PR attached is still holding nothing, but the inverse — a real ff branch — must stay
# landed. Pinned by the `ff` row above, which is zero-ahead too and resolves the other way.

# ── fail-safe: no gh at all ─────────────────────────────────────────────────────────────────────
# git must stay reachable or these rows would pass for the wrong reason — a broken merge-base
# also returns "not landed", which is the answer we are trying to attribute to the missing gh.
mkdir -p "$TMP/nogh"
ln -sf "$(command -v git)" "$TMP/nogh/git"
nogh() { PATH="$TMP/nogh" wt_branch_landed "$R" "$1" dev && echo yes || echo no; }
expect no "$(nogh squashed)" "no gh on PATH → not landed (never delete on a failed lookup)"
# CHANGED by #1986, deliberately. This row used to expect `yes`: a true ancestor resolved offline.
# It cannot any more, because offline there is no way to tell a fast-forwarded branch from a fresh
# one — both are ancestors carrying zero commits, and after a fast-forward the branch tip IS the
# base tip, which is exactly where `pnpm wt` starts a new branch. Given that, the asymmetry stated
# at the top of this file decides it: a false "landed" is somebody's work deleted, a false "not
# landed" is one worktree surviving one more sweep. So offline, a zero-ahead branch is kept.
# The cost is real but small, and it only applies with gh missing — with gh present, `ff` still
# resolves as landed (row above). Every dev PR squash-merges anyway, so a true fast-forward is
# close to nonexistent in this repo.
expect no "$(nogh ff)" "no gh on PATH → a zero-ahead branch is KEPT, since ff and fresh are indistinguishable offline"

echo ""
if [ "$fails" = 0 ]; then
	echo "✓ all rows passed"
else
	echo "✗ $fails row(s) failed" >&2
fi
exit "$((fails > 0))"
