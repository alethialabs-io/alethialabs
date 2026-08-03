#!/usr/bin/env bash
#
# Acceptance test for the worktree-ownership guard — drives .claude/hooks/guard-worktree.sh with
# synthetic PreToolUse payloads against a REAL leased worktree, and asserts allow/block per case.
#
# This is the incident replayed as a test: every row marked BLOCK is a step the second instance
# actually took on 2026-07-26 and was allowed to take.
#
# Usage: bash scripts/lib/wt-lease-hook-test.sh
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1
ROOT="$PWD"
HOOK="$ROOT/.claude/hooks/guard-worktree.sh"
. "$ROOT/scripts/lib/wt-lease.sh"

fails=0
pass() { echo "ok   - $1"; }
fail() {
	echo "FAIL - $1" >&2
	fails=$((fails + 1))
}

TMP="$(mktemp -d)"
trap 'git -C "$TMP/main" worktree remove --force "$TMP/wt" 2>/dev/null; rm -rf "$TMP"' EXIT

# A throwaway repo with one linked worktree, so nothing here can touch the real tree.
git init -q "$TMP/main"
(cd "$TMP/main" && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init)
git -C "$TMP/main" worktree add -q -b hooktest "$TMP/wt" >/dev/null 2>&1
MAIN="$(cd "$TMP/main" && pwd)"
WT="$(cd "$TMP/wt" && pwd)"

# Lease the worktree to pid 1 — always alive, never us. This is "another live instance".
LD="$(CLAUDE_PROJECT_DIR="$MAIN" wt_lease_dir "$WT")"
mkdir -p "$LD"
{
	echo "pid: 1"
	echo "procStart: $(wt_procstart 1)"
	echo "host: $(wt_host)"
	echo "session: someone-else"
	echo "branch: hooktest"
	echo "acquiredAt: $(date +%s)"
} >"$LD/owner"

# Run the hook with a payload; echo ALLOW / BLOCK.
run() { # <json>
	local rc
	printf '%s' "$1" | CLAUDE_PROJECT_DIR="$MAIN" CLAUDE_PID="$$" bash "$HOOK" >/dev/null 2>&1
	rc=$?
	[ "$rc" = 2 ] && echo BLOCK || echo ALLOW
}

bash_payload() { printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"%s"}}' "${2:-$MAIN}" "$1"; }
edit_payload() { printf '{"tool_name":"Edit","cwd":"%s","tool_input":{"file_path":"%s","old_string":"a","new_string":"b"}}' "$MAIN" "$1"; }

expect() { # <want> <got> <name>
	[ "$1" = "$2" ] && pass "$3" || fail "$3: want $1 got $2"
}

echo "── the incident: writes into another live instance's worktree ──"
expect BLOCK "$(run "$(edit_payload "$WT/lib/thing.ts")")" "Edit a file in a foreign worktree"
expect BLOCK "$(run "$(edit_payload "$WT/newdir/newfile.ts")")" "Edit a NOT-YET-EXISTING file in a foreign worktree"
expect BLOCK "$(run "$(bash_payload "cd $WT && git add -A && git commit -m x")")" "cd + git add -A + commit"
expect BLOCK "$(run "$(bash_payload "git -C $WT commit -m x")")" "git -C <foreign> commit"
expect BLOCK "$(run "$(bash_payload "git -C $WT rebase origin/dev")")" "git -C <foreign> rebase"
expect BLOCK "$(run "$(bash_payload "git -C $WT push --force")")" "git -C <foreign> push --force"
expect BLOCK "$(run "$(bash_payload "sed -i  s/x/y/ $WT/f.ts")")" "sed -i into a foreign worktree"
expect BLOCK "$(run "$(bash_payload "rm -rf $WT")")" "rm -rf a foreign worktree"
expect BLOCK "$(run "$(bash_payload "cp a.txt $WT/b.txt")")" "cp into a foreign worktree"
expect BLOCK "$(run "$(bash_payload "pnpm install" "$WT")")" "a command whose CWD is a foreign worktree"

echo "── reads stay allowed ──"
expect ALLOW "$(run "$(bash_payload "git -C $WT status")")" "git status in a foreign worktree"
expect ALLOW "$(run "$(bash_payload "git -C $WT log --oneline -5")")" "git log in a foreign worktree"
expect ALLOW "$(run "$(bash_payload "git -C $WT diff origin/dev")")" "git diff in a foreign worktree"
expect ALLOW "$(run "$(bash_payload "git -C $WT worktree list")")" "git worktree list"

echo "── piped git reads are still reads (the guard's own false-block regression) ──"
# `| head` is its own `;|&` segment, and `head` is not in the git allowlist — so requiring EVERY
# segment to be a git read blocked routine inspection of another worktree. A segment that never
# names the foreign tree cannot harm it.
expect ALLOW "$(run "$(bash_payload "git -C $WT log --oneline | head -3")")" "git log piped to head"
expect ALLOW "$(run "$(bash_payload "git -C $WT status | grep -c modified")")" "git status piped to grep"
expect ALLOW "$(run "$(bash_payload "git -C $WT diff | wc -l")")" "git diff piped to wc"
# …but a sink that writes BACK into the tree still names it, so it is still judged.
expect BLOCK "$(run "$(bash_payload "git -C $WT log | tee $WT/out.txt")")" "git log piped into the foreign tree"
expect BLOCK "$(run "$(bash_payload "cat $WT/f.ts | head -3")")" "cat from the foreign tree, piped"
# Residency is judged as a whole: `cd` in, then a write that names no path at all.
expect BLOCK "$(run "$(bash_payload "cd $WT && rm -rf .")")" "cd in, then rm -rf . (names no path)"

echo "── my own worktree is never blocked ──"
rm -rf "$LD"
expect ALLOW "$(run "$(edit_payload "$WT/lib/thing.ts")")" "Edit in an UNLEASED worktree (acquires)"
expect ALLOW "$(run "$(edit_payload "$WT/lib/other.ts")")" "Edit again — now mine"
expect ALLOW "$(run "$(bash_payload "cd $WT && git add -A && git commit -m x")")" "commit in MY worktree"

echo "── a dead holder is reclaimed, not honoured ──"
mkdir -p "$LD"
{
	echo "pid: 999999"
	echo "procStart: Thu Jan  1 00:00:00 1970"
	echo "host: $(wt_host)"
} >"$LD/owner"
expect ALLOW "$(run "$(edit_payload "$WT/lib/thing.ts")")" "Edit after the holder died"

echo "── escape hatch + non-Claude ──"
mkdir -p "$LD"
{
	echo "pid: 1"
	echo "procStart: $(wt_procstart 1)"
	echo "host: $(wt_host)"
} >"$LD/owner"
rc=$(printf '%s' "$(edit_payload "$WT/f.ts")" | CLAUDE_PROJECT_DIR="$MAIN" CLAUDE_PID="$$" ALETHIA_ALLOW_FOREIGN_WT=1 bash "$HOOK" >/dev/null 2>&1; echo $?)
expect ALLOW "$([ "$rc" = 2 ] && echo BLOCK || echo ALLOW)" "ALETHIA_ALLOW_FOREIGN_WT=1 overrides"
# `env -u`, not just "don't set it": this test runs INSIDE a Claude session, so CLAUDE_PID is
# already exported into our environment and would be inherited by the hook.
rc=$(printf '%s' "$(edit_payload "$WT/f.ts")" | env -u CLAUDE_PID CLAUDE_PROJECT_DIR="$MAIN" bash "$HOOK" >/dev/null 2>&1; echo $?)
expect ALLOW "$([ "$rc" = 2 ] && echo BLOCK || echo ALLOW)" "no CLAUDE_PID (human / CI) is never gated"

echo "── the original main-checkout rule still fires ──"
rc=$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"git add -A && git commit -m x"}}' "$MAIN" |
	CLAUDE_PROJECT_DIR="$MAIN" CLAUDE_PID="$$" bash "$HOOK" >/dev/null 2>&1; echo $?)
expect BLOCK "$([ "$rc" = 2 ] && echo BLOCK || echo ALLOW)" "git add -A + commit in the MAIN checkout"

# R-MAIN in its own right. Drop the lease first: everything below is about the MAIN-checkout rule,
# and a leased $WT would have R-LEASE answer first and hide what R-MAIN actually decides.
rm -rf "$LD"

echo "── R-MAIN covers rebase: rewriting the shared checkout moves dev under every session ──"
expect BLOCK "$(run "$(bash_payload "git rebase origin/dev")")" "bare rebase in the MAIN checkout"
expect BLOCK "$(run "$(bash_payload "git rebase -i HEAD~3")")" "interactive rebase in the MAIN checkout"
expect BLOCK "$(run "$(bash_payload "git rebase --onto origin/dev abc123 feat/x")")" "rebase --onto in the MAIN checkout"
expect BLOCK "$(run "$(bash_payload "cd $MAIN && git rebase origin/dev")")" "cd MAIN, then rebase"

echo "── …but a rebase already in progress must always be finishable ──"
# Blocking these strands a session mid-rebase with no way out — strictly worse than the thing the
# rule prevents. They finish or unwind a rewrite; they never start one.
expect ALLOW "$(run "$(bash_payload "git rebase --abort")")" "rebase --abort"
expect ALLOW "$(run "$(bash_payload "git rebase --continue")")" "rebase --continue"
expect ALLOW "$(run "$(bash_payload "git rebase --skip")")" "rebase --skip"
expect ALLOW "$(run "$(bash_payload "git rebase --quit")")" "rebase --quit"
# The carve-out is a STRIP, not an early exit, so it cannot be used to smuggle a real rebase past.
expect BLOCK "$(run "$(bash_payload "git rebase --abort && git rebase origin/dev")")" "a control form does not launder a real rebase"

echo "── git's GLOBAL options used to hide the subcommand entirely ──"
# The trigger required `git` IMMEDIATELY followed by the subcommand, so every one of these ran
# unguarded in the shared checkout — CLAUDE.md's non-negotiable #1 defeated by four characters.
# It also left the `git -C …` branch of the target resolution unreachable, which is why the block
# message could claim `git -C ../wt-<name> …` was "parsed and allowed" when it was merely unparsed.
expect BLOCK "$(run "$(bash_payload "git -C $MAIN commit -m x")")" "git -C <MAIN> commit"
expect BLOCK "$(run "$(bash_payload "git -C $MAIN add -A")")" "git -C <MAIN> add -A"
expect BLOCK "$(run "$(bash_payload "git -C $MAIN rebase origin/dev")")" "git -C <MAIN> rebase"
expect BLOCK "$(run "$(bash_payload "git --no-pager commit -m x")")" "git --no-pager commit"
expect BLOCK "$(run "$(bash_payload "git -c user.name=x commit -m x")")" "git -c <cfg> commit"

echo "── a worktree of my own is still the way to work ──"
expect ALLOW "$(run "$(bash_payload "git -C $WT rebase origin/dev")")" "git -C <my worktree> rebase"
expect ALLOW "$(run "$(bash_payload "cd $WT && git rebase origin/dev")")" "cd <my worktree>, then rebase"
expect ALLOW "$(run "$(bash_payload "git -C $WT commit -m x")")" "git -C <my worktree> commit"
expect ALLOW "$(run "$(bash_payload "git -C $WT add -A")")" "git -C <my worktree> add -A"

echo "── no over-reach: the rule must not eat ordinary git ──"
expect ALLOW "$(run "$(bash_payload "git status --short")")" "git status"
expect ALLOW "$(run "$(bash_payload "git log --oneline -5")")" "git log"
expect ALLOW "$(run "$(bash_payload "git config --get rebase.autosquash")")" "a config key that merely contains the word"
expect ALLOW "$(run "$(bash_payload "echo we should rebase later")")" "the word rebase in prose"

echo ""
if [ "$fails" = 0 ]; then
	echo "guard-worktree acceptance: all passed"
else
	echo "guard-worktree acceptance: $fails failed" >&2
fi
exit "$fails"
