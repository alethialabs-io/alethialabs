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

echo ""
if [ "$fails" = 0 ]; then
	echo "guard-worktree acceptance: all passed"
else
	echo "guard-worktree acceptance: $fails failed" >&2
fi
exit "$fails"
