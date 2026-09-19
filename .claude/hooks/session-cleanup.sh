#!/usr/bin/env bash
# SessionStart / SessionEnd hook: sweep the hygiene that nothing was running.
#
# Three things drifted because each had a documented remedy and no owner:
#
#   1. The MAIN CHECKOUT falls behind `origin/dev`. Hooks, `settings.json` and CLAUDE.md
#      all resolve through $CLAUDE_PROJECT_DIR, so a session working in a worktree is
#      gated by app/'s copies — and a fix to a guard cannot take effect for the session
#      that wrote it. `session-runtime.sh` has warned about this for months and printed
#      the exact command; on 2026-09-15 it was 23 commits behind and had been for days.
#      A warning nobody acts on is a warning that does not work.
#   2. Landed worktrees pile up. 67 entries, 62 of them `wt-*`, most of them merged.
#   3. Their branches outlive them. 243 local branches against 102 on the remote.
#
# WHAT THIS DOES NOT DO, deliberately: it never removes a tree with uncommitted or
# untracked work, never removes a branch that is not landed, and never forces anything.
# It delegates all three judgements to `worktree.sh --prune` and `branch-prune.sh`,
# which already refuse correctly and have the scars to prove it. This script adds no
# new opinion about what is safe to delete; it only decides WHEN to ask them.
#
# THE SAME TWO HARD RULES AS session-runtime.sh, for the same reasons:
#   1. NEVER BLOCK A SESSION. Every command is timeout-wrapped, every failure swallowed.
#      Registered with `"async": true` on both events precisely because the honest
#      runtime is ~65s for the worktree sweep and minutes for the branch sweep — a
#      session that will not start because a prune is walking 200 branches is a far
#      worse bug than a tree that gets swept one session later.
#   2. Always exit 0.
#
# Ctrl+C: interrupting a TURN is not an observable event — no hook fires for it. Ctrl+C
# that EXITS the session is SessionEnd, which is covered. This must never be registered
# on `Stop`, which fires at the end of every turn: that would prune worktrees out from
# under lanes that are mid-build.
set -u

MODE="full" # full = SessionStart · quick = SessionEnd · self-test
case "${1:-}" in
--quick) MODE="quick" ;;
--self-test) MODE="self-test" ;;
esac

say() { printf '%s\n' "$1"; }

# `timeout` is GNU; macOS has it only via coreutils. Degrade to running bare rather than
# skipping the sweep — same choice session-runtime.sh makes, for the same reason.
if command -v timeout >/dev/null 2>&1; then
	TO() { timeout "$@"; }
elif command -v gtimeout >/dev/null 2>&1; then
	TO() { gtimeout "$@"; }
else
	TO() {
		shift
		"$@"
	}
fi

# ── the decision predicates ─────────────────────────────────────────────────────────────
# Pure, argument-in/answer-out, so --self-test can exercise them without a repo. Every
# one of them is a place this script could get it wrong; none of them deletes anything.

# A fast-forward is safe ONLY when the checkout is behind and not ahead. `--ff-only`
# would refuse a diverged checkout anyway, but refusing here means the log says WHY
# rather than surfacing git's error text at a user who did not run git.
#
# 0 = pull · 1 = nothing to do · 2 = refuse (diverged, or local commits)
cleanup_should_pull() { # <behind> <ahead>
	local behind="${1:-0}" ahead="${2:-0}"
	case "$behind" in '' | *[!0-9]*) behind=0 ;; esac
	case "$ahead" in '' | *[!0-9]*) ahead=0 ;; esac
	[ "$ahead" -gt 0 ] && return 2
	[ "$behind" -eq 0 ] && return 1
	return 0
}

# The branch sweep costs minutes and only ever removes LANDED branches, so there is no
# value in running it at session END: the session is exiting, nothing is waiting on the
# result, and an async hook whose process is being torn down may not finish. Worse, a
# prune killed mid-flight can leave the lease it took behind. SessionStart runs the full
# sweep; SessionEnd runs the cheap half and lets the next start finish the job.
cleanup_runs_branch_sweep() { # <mode>
	[ "${1:-}" = "full" ]
}

# Resolve the tree whose .claude/ is actually in force. In a linked worktree the git
# common dir is the MAIN checkout's .git, so its parent is the main checkout. Same
# derivation as session-runtime.sh — they must not disagree about which tree they mean.
cleanup_main_checkout_from_common_dir() { # <git-common-dir> <fallback>
	local gc="${1:-}" fallback="${2:-}"
	case "$gc" in
	*/.git) (cd "$(dirname "$gc")" 2>/dev/null && pwd) || printf '%s' "$fallback" ;;
	*) printf '%s' "$fallback" ;;
	esac
}

# ── self-test ───────────────────────────────────────────────────────────────────────────
# Counters are incremented in THIS shell, never a subshell: `fails=$((fails+1))` inside a
# pipeline or `$( )` is lost on the way out, which is how a harness prints FAIL and then
# summarises "all passed". The exit code is the test; the text is only a report.
if [ "$MODE" = "self-test" ]; then
	fails=0
	ok() { # <label> <expected-rc> <actual-rc>
		if [ "$2" = "$3" ]; then
			say "  ok   $1"
		else
			say "  FAIL $1 — expected rc $2, got $3"
			fails=$((fails + 1))
		fi
	}
	eq() { # <label> <expected> <actual>
		if [ "$2" = "$3" ]; then
			say "  ok   $1"
		else
			say "  FAIL $1 — expected '$2', got '$3'"
			fails=$((fails + 1))
		fi
	}

	say "session-cleanup --self-test"

	cleanup_should_pull 23 0 && rc=0 || rc=$?
	ok "behind 23, ahead 0 → pull" 0 "$rc"
	cleanup_should_pull 0 0 && rc=0 || rc=$?
	ok "level → nothing to do" 1 "$rc"
	cleanup_should_pull 5 2 && rc=0 || rc=$?
	ok "diverged → refuse" 2 "$rc"
	cleanup_should_pull 0 3 && rc=0 || rc=$?
	ok "ahead only → refuse (never discard local commits)" 2 "$rc"
	cleanup_should_pull "" "" && rc=0 || rc=$?
	ok "unparseable counts → treated as level, not as pull" 1 "$rc"
	cleanup_should_pull "abc" 0 && rc=0 || rc=$?
	ok "garbage behind → treated as 0, not as pull" 1 "$rc"

	cleanup_runs_branch_sweep full && rc=0 || rc=$?
	ok "full mode runs the branch sweep" 0 "$rc"
	cleanup_runs_branch_sweep quick && rc=0 || rc=$?
	ok "quick mode does NOT run the branch sweep" 1 "$rc"

	eq "common dir ending in /.git resolves to its parent" \
		"/tmp" "$(cleanup_main_checkout_from_common_dir /tmp/.git /fallback)"
	eq "a linked worktree's own gitdir is not mistaken for a checkout" \
		"/fallback" "$(cleanup_main_checkout_from_common_dir /repo/.git/worktrees/wt-x /fallback)"
	eq "empty common dir falls back" \
		"/fallback" "$(cleanup_main_checkout_from_common_dir "" /fallback)"

	if [ "$fails" -eq 0 ]; then
		say "✓ all passed"
		exit 0
	fi
	say "✗ $fails failed"
	exit 1
fi

# ── single flight ───────────────────────────────────────────────────────────────────────
# Two sessions starting together would otherwise run two prunes over one worktree list.
# `mkdir` is the arbiter — the same primitive wt-lease.sh uses, for the same reason. A
# lock older than 30 minutes is a crashed run, not a live one; nothing here takes that long.
ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
GIT_COMMON="$(TO 3 git -C "$ROOT" rev-parse --git-common-dir 2>/dev/null || true)"
[ -n "$GIT_COMMON" ] && GIT_COMMON="$(cd "$GIT_COMMON" 2>/dev/null && pwd || printf '%s' "$GIT_COMMON")"
MAIN_CHECKOUT="$(cleanup_main_checkout_from_common_dir "$GIT_COMMON" "$ROOT")"

LOCK="${TMPDIR:-/tmp}/alethia-session-cleanup.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
	_age=0
	if [ -d "$LOCK" ]; then
		_now="$(date +%s 2>/dev/null || echo 0)"
		_mt="$(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null || echo "$_now")"
		_age=$((_now - _mt))
	fi
	if [ "$_age" -lt 1800 ]; then
		say "session-cleanup: another sweep is running (lock ${_age}s old) — skipping."
		exit 0
	fi
	rm -rf "$LOCK" 2>/dev/null || true
	mkdir "$LOCK" 2>/dev/null || exit 0
fi
trap 'rm -rf "$LOCK" 2>/dev/null || true' EXIT

say ""
say "── session-cleanup (${MODE}) ────────────────────────────────────────"

# ── 1. bring the harness current ────────────────────────────────────────────────────────
# Only on SessionStart. At SessionEnd nothing is about to read the harness, and advancing
# app/ under other live sessions for no benefit is a cost with no payer.
if [ "$MODE" = "full" ]; then
	TO 20 git -C "$MAIN_CHECKOUT" fetch -q origin dev >/dev/null 2>&1 || true
	behind="$(TO 5 git -C "$MAIN_CHECKOUT" rev-list --count HEAD..origin/dev 2>/dev/null || echo 0)"
	ahead="$(TO 5 git -C "$MAIN_CHECKOUT" rev-list --count origin/dev..HEAD 2>/dev/null || echo 0)"

	cleanup_should_pull "$behind" "$ahead"
	case "$?" in
	0)
		# A fast-forward is neither a commit nor a rebase, so guard-worktree.sh's R-MAIN
		# does not see it and CLAUDE.md §7 prescribes this exact command. It can still
		# abort on an untracked-file collision — that is non-destructive, and saying so
		# is more useful than hiding it.
		if TO 60 git -C "$MAIN_CHECKOUT" pull --ff-only -q >/dev/null 2>&1; then
			say "  harness   ff-forwarded ${behind} commit(s) → origin/dev"
		else
			say "  harness   ⚠ ${behind} behind; --ff-only declined (untracked collision?)"
			say "            nothing was changed. Resolve by hand:"
			say "              git -C ${MAIN_CHECKOUT} pull --ff-only"
		fi
		;;
	1) say "  harness   level with origin/dev" ;;
	2) say "  harness   ⚠ ${ahead} local commit(s) in the main checkout — NOT pulling" ;;
	esac
fi

# ── 2. worktrees ────────────────────────────────────────────────────────────────────────
# `--prune` skips a tree with uncommitted or untracked work, skips one whose branch has
# not landed, skips one a live instance holds, and calls `git worktree remove` without
# --force so git gets the last word. None of that judgement lives here.
_wt_before="$(TO 5 git -C "$MAIN_CHECKOUT" worktree list 2>/dev/null | wc -l | tr -d ' ')"
TO 300 bash "$MAIN_CHECKOUT/scripts/worktree.sh" --prune >/dev/null 2>&1 || true
_wt_after="$(TO 5 git -C "$MAIN_CHECKOUT" worktree list 2>/dev/null | wc -l | tr -d ' ')"
case "$_wt_before$_wt_after" in
*[!0-9]*) say "  worktrees could not be counted" ;;
*) say "  worktrees $_wt_before → $_wt_after" ;;
esac

# ── 3. branches ─────────────────────────────────────────────────────────────────────────
if cleanup_runs_branch_sweep "$MODE"; then
	_br_before="$(TO 5 git -C "$MAIN_CHECKOUT" branch --list 2>/dev/null | wc -l | tr -d ' ')"
	TO 600 bash "$MAIN_CHECKOUT/scripts/branch-prune.sh" >/dev/null 2>&1 || true
	_br_after="$(TO 5 git -C "$MAIN_CHECKOUT" branch --list 2>/dev/null | wc -l | tr -d ' ')"
	case "$_br_before$_br_after" in
	*[!0-9]*) say "  branches  could not be counted" ;;
	*) say "  branches  $_br_before → $_br_after" ;;
	esac
fi

# ── 4. the census of what was deliberately left ─────────────────────────────────────────
# The trees the sweep refuses are the whole reason this is not a silent cron. `--prune`
# will NEVER reclaim them, so without a count they are invisible until someone runs
# `wt:who` by hand and reads 40 lines. One number, and the command that explains it.
_dirty=0
_unpushed=0
while IFS= read -r _wt; do
	[ -n "$_wt" ] || continue
	case "$_wt" in */wt-*) ;; *) continue ;; esac
	[ -d "$_wt" ] || continue
	if [ -n "$(TO 5 git -C "$_wt" status --porcelain 2>/dev/null || true)" ]; then
		_dirty=$((_dirty + 1))
		continue
	fi
	_n="$(TO 5 git -C "$_wt" log --oneline '@{u}..' 2>/dev/null | wc -l | tr -d ' ')"
	case "$_n" in '' | *[!0-9]*) _n=0 ;; esac
	[ "$_n" -gt 0 ] && _unpushed=$((_unpushed + 1))
done <<EOF
$(TO 10 git -C "$MAIN_CHECKOUT" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' || true)
EOF

if [ "$((_dirty + _unpushed))" -gt 0 ]; then
	say "  kept      ${_dirty} tree(s) with uncommitted work, ${_unpushed} with unpushed commits"
	say "            the sweep refuses these by design and always will — pnpm wt:who"
	say "            give back their node_modules without touching the work: pnpm wt:dehydrate"
fi
say "─────────────────────────────────────────────────────────────────────"

exit 0
