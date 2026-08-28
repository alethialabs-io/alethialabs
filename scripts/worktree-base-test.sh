#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# WHERE DOES `pnpm wt <name>` START THE BRANCH? Hermetic, over a real git repo built in a tmpdir.
#
# THE FAILURE THIS PINS. `pnpm wt hetzner-zone-depth` printed "created … (off origin/dev)" and put
# the worktree 125 commits behind dev, on the branch of a MERGED PR whose remote ref still existed.
# Nothing in the output said so. Two files edited there would have been REVERTED by the resulting
# PR, and the diff would have read as deliberate.
#
# WHY IT NEEDS A REAL REPO. The bug is entirely in git's DWIM: `git worktree add <dir> <branch>`
# resolves a bare name to `refs/remotes/origin/<branch>` when no local branch exists. No amount of
# reading the script shows that; only running it against a repo that HAS such a ref does.
#
# WHY THE FIXTURE SQUASH-MERGES. `--is-ancestor` is the obvious test for "already landed" and it is
# useless here: Mergify squashes every dev PR, so a landed branch is never an ancestor of dev — 0 of
# the 13 remote feat/* branches in the real repo pass it. A fixture that fast-forwards would let a
# broken implementation pass. The merge below therefore lands the TREE and not the commit, which is
# the only shape this repo ever produces.
#
# gh is not available to the fixture, so wt_branch_landed() takes its documented FAIL-SAFE path and
# answers "not landed". That is the conservative direction and it is what the assertions expect: the
# branch is continued, LOUDLY, rather than silently. The property under test is that the message
# tells the truth about where the branch started and how far behind it is — which is the half that
# was missing, and the half that does not depend on a network lookup.

set -uo pipefail

pass=0
fail=0
ok() { # <label> <condition-result> [detail]
	if [ "$2" = "0" ]; then
		echo "ok   - $1"
		pass=$((pass + 1))
	else
		echo "FAIL - $1${3:+: $3}"
		fail=$((fail + 1))
	fi
}
says() { # <label> <needle>
	if grep -qF "$2" "$OUT"; then ok "$1" 0; else ok "$1" 1 "output did not contain: $2"; fi
}
denies() { # <label> <needle>
	if grep -qF "$2" "$OUT"; then ok "$1" 1 "output SHOULD NOT contain: $2"; else ok "$1" 0; fi
}

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/worktree.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
OUT="$tmp/out.txt"

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# ── a remote with dev, and a feat/ branch whose work has been SQUASHED onto dev ──
remote="$tmp/remote.git"
git init -q --bare "$remote"
seed="$tmp/seed"
git init -q -b dev "$seed"
mkdir -p "$seed/scripts"
cp "$script" "$seed/scripts/worktree.sh"
mkdir -p "$seed/scripts/lib"
cp "$(dirname "$script")/lib/wt-landed.sh" "$seed/scripts/lib/wt-landed.sh"
cp "$(dirname "$script")/lib/wt-lease.sh" "$seed/scripts/lib/wt-lease.sh" 2>/dev/null || true
echo base > "$seed/file.txt"
git -C "$seed" add -A >/dev/null
git -C "$seed" commit -qm base

git -C "$seed" checkout -qb feat/landed
echo "the landed change" > "$seed/file.txt"
git -C "$seed" commit -qam "landed work"
landed_tip="$(git -C "$seed" rev-parse HEAD)"

# The squash: dev gets the TREE with a brand-new oid, exactly as Mergify produces it. The branch tip
# is NOT an ancestor of dev afterwards, which is the whole point of the fixture.
git -C "$seed" checkout -q dev
git -C "$seed" merge -q --squash feat/landed >/dev/null 2>&1
git -C "$seed" commit -qm "landed work (#999)"
for _ in 1 2 3 4 5; do
	echo "more" >> "$seed/file.txt"
	git -C "$seed" commit -qam "more dev work"
done
git -C "$seed" remote add origin "$remote"
git -C "$seed" push -q origin dev feat/landed

git -C "$seed" merge-base --is-ancestor "$landed_tip" dev 2>/dev/null &&
	{ echo "FIXTURE BROKEN: the squash left the branch an ancestor of dev"; exit 1; }

# ── the checkout `pnpm wt` runs in ──
work="$tmp/work"
git clone -q "$remote" "$work"
git -C "$work" checkout -q dev
dev_tip="$(git -C "$work" rev-parse --short dev)"

run_wt() { (cd "$work" && bash scripts/worktree.sh "$1" >"$OUT" 2>&1); }

# ── 1 · a fresh name starts on dev and says so ──
run_wt fresh-name
says "a fresh name reports the base it used" "off origin/dev"
says "...and reports it is level with the base" "level with origin/dev"
behind="$(git -C "$work/../work/../work" rev-list --count HEAD..dev 2>/dev/null || echo x)"
ok "a fresh worktree is created at dev's tip" \
	"$([ "$(git -C "$tmp/wt-fresh-name" rev-parse --short HEAD)" = "$dev_tip" ] && echo 0 || echo 1)" \
	"$(git -C "$tmp/wt-fresh-name" rev-parse --short HEAD 2>/dev/null) vs $dev_tip"

# ── 2 · THE REGRESSION: a name whose remote branch still exists, from landed work ──
run_wt landed
denies "a stale remote branch is NEVER reported as 'off origin/dev'" "off origin/dev"
says "...the distance from the base is stated as a number" "commit(s) BEHIND origin/dev"
says "...and the line is a warning, not a footnote" "⚠ at"
ok "...and the tree is NOT silently left at dev's tip while claiming otherwise" \
	"$([ -d "$tmp/wt-landed" ] && echo 0 || echo 1)" "worktree was not created"

# The load-bearing assertion. Before the fix this printed "(off origin/dev)" while checking out a
# tree 6 commits older — the exact shape that would have shipped a 125-commit revert.
head_now="$(git -C "$tmp/wt-landed" rev-parse HEAD 2>/dev/null || echo none)"
if [ "$head_now" = "$dev_tip" ] || [ "$head_now" = "$(git -C "$work" rev-parse dev)" ]; then
	ok "if it starts at dev, the message must have said 'off origin/dev'" \
		"$(grep -qF "off origin/dev" "$OUT" && echo 0 || echo 1)"
else
	ok "if it starts elsewhere, the message must NOT claim 'off origin/dev'" \
		"$(grep -qF "off origin/dev" "$OUT" && echo 1 || echo 0)"
	says "...and it names what it started from instead" "origin/feat/landed"
fi

# ── 3 · a LOCAL branch is a resume, and is labelled as one ──
git -C "$work" branch -q feat/local-resume dev
run_wt local-resume
says "an existing local branch is reported as a resume" "resuming your existing local branch"
denies "...and is not described as a fresh start off the base" "off origin/dev"

echo
if [ "$fail" -eq 0 ]; then
	echo "worktree-base self-test: all $pass passed"
	exit 0
fi
echo "worktree-base self-test: $fail of $((pass + fail)) FAILED"
exit 1
