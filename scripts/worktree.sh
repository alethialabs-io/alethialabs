#!/usr/bin/env bash
#
# One-worktree-per-instance helper (see CLAUDE.md → Local stack). Makes the compliant
# path a single command so the enforcement hooks aren't painful:
#
#   pnpm wt <name>            create ../wt-<name> on feat/<name> off dev, print next steps
#   pnpm wt <name> --install  … and run `pnpm install` in the new worktree
#   pnpm wt:ls                list worktrees (alias → git worktree list)
#   pnpm wt:who               who holds each worktree (live | stale | free)
#   pnpm wt:rm <name> · pnpm wt:prune         remove ../wt-<name>
#   pnpm wt:dehydrate [--dry-run]             reap node_modules from trees nobody holds
#   pnpm wt:release [name]    hand your worktree back
#   pnpm wt:steal <name>      take a worktree whose holder is really gone
#
#   bash scripts/worktree.sh --self-test      the dehydrate fixtures (hermetic; touches no worktree)
#
# Worktrees are sibling dirs of app/ named `wt-<name>`; the main app/ checkout stays on
# the integration branch `dev` and never holds feature work.
#
# OWNERSHIP. Creating or reusing a worktree takes a LEASE on it (scripts/lib/wt-lease.sh).
# This used to be the hole: `pnpm wt <name>` on a name another live instance already held
# printed "already exists … Reusing it" and handed over their tree — after which a
# `git add` + `git commit` swept their uncommitted work into someone else's commit
# (issue #1247). Both that path and `--remove` (which is worse: it DESTROYS rather than
# tangles) now refuse a worktree a live instance holds.
set -euo pipefail

cd "$(dirname "$0")/.." # the invoking worktree's top-level

# shellcheck source=lib/wt-lease.sh
. "$(dirname "$0")/lib/wt-lease.sh"
# shellcheck source=lib/wt-landed.sh
. "$(dirname "$0")/lib/wt-landed.sh"

usage() {
	echo "Usage: pnpm wt <name> [--install] | pnpm wt:ls | pnpm wt:who | pnpm wt:prune [--dry-run] | pnpm wt:dehydrate [--dry-run] | pnpm wt:rm <name> | pnpm wt:release [name] | pnpm wt:steal <name>" >&2
	exit 1
}

# Refuse to touch a worktree a live instance holds. Prints who, and the three ways out.
require_free() { # <dir> <verb>
	local dir="$1" verb="$2" ld abs rc=0
	wt_lease_acquire "$dir" || rc=$?
	[ "$rc" = 0 ] && return 0
	[ "$rc" = 2 ] && return 0 # not a linked worktree — nothing to own
	abs="$(cd "$dir" 2>/dev/null && pwd -P || echo "$dir")"
	ld="$(wt_lease_dir "$dir" 2>/dev/null || true)"
	{
		echo "✗ refusing to $verb $abs — another LIVE Claude instance is working in it."
		echo "    holder   pid ${WT_L_PID:-?} (started ${WT_L_PS:-?}) on ${WT_L_HOST:-?}"
		echo "    session  ${WT_L_SESSION:-?}   ·   branch ${WT_L_BRANCH:-?}"
		echo "    leased   $(wt_lease_age 2>/dev/null || echo '?') ago   ·   last active $(wt_lease_idle "$ld" 2>/dev/null || echo unknown)"
		echo ""
		echo "  Reusing or removing it would take their uncommitted work with it (issue #1247)."
		echo "  Use a name of your own:        pnpm wt <another-name>"
		echo "  See every holder:              pnpm wt:who"
		echo "  They really are gone:          pnpm wt:steal ${abs##*/wt-}"
		echo "  Deliberate (maintainer only):  ALETHIA_ALLOW_FOREIGN_WT=1 …"
	} >&2
	exit 1
}

# `main` from wt_lease_state() means "wt_lease_dir refused", which is TRUE for the shared main
# checkout and equally true for a tree whose .git git can no longer read — and a broken .git is
# exactly what an abandoned worktree has. One state, two very different sentences. Shared by
# `--who` and by the verdict, because having it in only one of them is how the two drifted:
# the fix landed in the verdict first and `--who` went on calling a corpse "the main checkout".
wt_is_readable_repo() { # <path>
	git -C "$1" rev-parse --absolute-git-dir >/dev/null 2>&1
}

# ── de-hydration: the regenerable half of a worktree ────────────────────────────────────────────
#
# Every reapable node_modules directory in <worktree>, one absolute path per line, sorted.
#
# TWO ORTHOGONAL tests per candidate, and each is the cheapest SOUND question rather than merely a
# cheap one. Both are asked of git rather than of the path's name: "it is called node_modules" is a
# rendering, and this function deletes.
#
#   · .gitignore calls it disposable   — `check-ignore --no-index`
#   · git TRACKS NOTHING under it      — `ls-files`
#
# `--no-index` is load-bearing and is the opposite of the obvious choice. WITHOUT it, check-ignore
# is index-aware — it answers "notign" for any path carrying a tracked file, because a tracked file
# is by definition not ignored — so it silently absorbs the second test and the `ls-files` guard
# becomes unreachable code that nothing can fail. That is a guard which passes for the wrong reason,
# and the day git's index-awareness changes shape it is a `rm -rf` over somebody's source. With
# `--no-index` the first test is a pure PATTERN question and the second is the whole of the
# tracked-file protection: two questions, two failure modes, two fixtures that can each fail alone.
#
# HONEST SCOPE: removing EITHER guard is caught by mutation, but removing only the `--no-index` flag
# is NOT — index-aware check-ignore refuses the same fixtures for its own reason, so the verdict is
# unchanged and nothing can observe the difference. The flag is here to keep the `ls-files` guard
# REACHABLE, not to change any answer; that is an argument about the code's shape, and no fixture
# can hold it. Said out loud so the next reader does not delete the flag, watch the suite stay
# green, and conclude it was decorative.
#
# The second test is not hypothetical: `git add -f` inside an ignored directory produces a path that
# is ignored by pattern and tracked in fact. It is rare, and its cost is somebody's source, so it is
# asked rather than assumed.
#
# `-prune` stops the walk AT each node_modules, which is not an optimisation — it is what keeps a
# pnpm store's tens of thousands of nested `.pnpm/*/node_modules` from being enumerated at all, and
# from being listed a second time under a parent that is about to take them anyway.
# `-type d` does not follow symlinks, so a symlinked node_modules is skipped: the safe direction.
#
# KNOWN GAP — tracked as #4609. There is no "stop at another worktree" prune here, so if one
# worktree were nested inside another, a `stale` outer tree's walk would list a LIVE inner tree's
# node_modules and the reap would take them: the inner tree's own lease is never consulted, because
# the lease is read per SWEPT tree, not per found path. Not reachable today — the harness nests only
# under `app/.claude/worktrees/`, whose parent is the main checkout and always skipped — but
# wt-lease.sh's longest-prefix root matching exists precisely because nested worktrees are a thing
# this harness creates.
#
# The trailing `|| true` is precautionary, and the precise reason matters more than the guard does.
# This script runs under `set -o pipefail`, and ONE unreadable directory in one abandoned tree makes
# find exit 1 and so the whole pipeline exit 1 (measured: a single `chmod 000` subdirectory). A
# caller that wrote `dirs="$(wt_node_modules_dirs "$wt")"` at the TOP LEVEL of this script would
# then abort the entire sweep under `set -e` — silently, with no line printed for any tree.
#
# No caller does that TODAY, and not by luck: every one of them reads this through a command
# substitution, and bash CLEARS -e inside a command-substitution subshell when it is not in POSIX
# mode. So the abort is unreachable from where it is called now, and — say it plainly — the
# self-test's unreadable-directory arms below pin the RESULT, not the abort; they cannot fail on a
# build with this `|| true` removed. The guard is here so that moving one call up into the main
# shell cannot quietly turn a permissions blip into a dead sweep.
#
# Either way the failure DIRECTION is chosen: an unreadable subtree costs a false "already
# de-hydrated" for that one tree, which deletes nothing.
wt_node_modules_dirs() { # <worktree> → absolute paths, one per line
	local wt="$1" d rel
	[ -d "$wt" ] || return 0
	find "$wt" -name .git -prune -o -type d -name node_modules -prune -print 2>/dev/null |
		sort |
		while IFS= read -r d; do
			rel="${d#"$wt"/}"
			[ "$rel" != "$d" ] || continue # not under $wt at all — never guess
			git -C "$wt" check-ignore --no-index -q -- "$rel" 2>/dev/null || continue
			[ -z "$(git -C "$wt" ls-files -- "$rel" 2>/dev/null | head -n 1)" ] || continue
			printf '%s\n' "$d"
		done || true
}

# Bytes ON DISK under <dir>. `du -sk` — 1024-blocks, the one unit both BSD and GNU du agree on —
# rather than a sum of apparent sizes.
#
# WHAT THIS NUMBER IS, AND IS NOT. du counts allocated blocks per inode and is BLIND TO SHARING, so
# every figure derived from it is an UPPER BOUND on what a reap gives back — not a prediction.
#
# MEASURED ON A REAL TREE, 2026-09-10, `df` either side of a by-hand reap:
#
#     before 9244 MB free · after 9297 MB free · ACTUALLY reclaimed 52 MB
#     du -sk for the same directories:                              1996 MB
#     ——————————————————————————————————————————————————————————————————————
#     overstatement:                                                    38x
#
# The mechanism, confirmed on this machine: `pnpm store path` holds 1.7 GB, and a sampled file
# under `node_modules/.pnpm` has nlink=1 with the store on the same volume — so these are APFS
# CLONES (copy-on-write), not hardlinks and not copies. A tree's node_modules is mostly references
# into the store, and a block is freed only when its LAST reference goes. A hardlinked store shares
# blocks just as invisibly; du cannot see either.
#
# So every figure this command prints is worded "up to N on disk", and that wording is not a hedge
# — it is the only honest form. The tool's whole justification is a disk number, and a maintainer
# reading "freed 1.9G" at 95% full will believe the problem is solved when 38/39ths of it is still
# there. `df` is the only thing that can answer what was actually reclaimed.
#
# AND THE 38x IS WHY THE COMMAND EXISTS, not an embarrassment to it. Dropping the last reference to
# a shared block is the ONLY thing that frees it, and nothing else in the harness does that for a
# tree which is simultaneously abandoned and un-prunable — such a tree pins its share of the store
# forever. The payoff is therefore in the SWEEP and in `pnpm store prune` after it, not in any one
# tree: which is exactly why the by-hand pass over FIVE trees plus a store prune moved 3.7 GB while
# one tree moves 52 MB. Do not restate #4580's "~2 GB per tree" as a saving; it is du's number.
#
# Unreadable or missing is 0, never an error: a sweep must not die on one tree. `|| true` for the
# same measured `set -o pipefail` reason as the walk above, and with the same caveat — du exits 1 on
# a subdirectory it cannot read while STILL printing a usable total, so the guard keeps the total;
# it is precautionary against a top-level caller, not load-bearing for today's.
wt_dir_bytes() { # <dir> → bytes
	local kb
	kb="$(du -sk "$1" 2>/dev/null | awk 'NR==1{print $1}' || true)"
	case "${kb:-}" in
		'' | *[!0-9]*) printf '0' ;;
		*) printf '%s' $((kb * 1024)) ;;
	esac
}

wt_human_bytes() { # <bytes> → 1.9G · 12.0M · 4.0K · 0B
	local b="${1:-0}"
	case "$b" in '' | *[!0-9]*) b=0 ;; esac
	if [ "$b" -ge 1073741824 ]; then
		awk -v b="$b" 'BEGIN{printf "%.1fG", b/1073741824}'
	elif [ "$b" -ge 1048576 ]; then
		awk -v b="$b" 'BEGIN{printf "%.1fM", b/1048576}'
	elif [ "$b" -ge 1024 ]; then
		awk -v b="$b" 'BEGIN{printf "%.1fK", b/1024}'
	else
		printf '%dB' "$b"
	fi
}

# The per-tree verdict, as one TAB-separated line: "<verb>\t<bytes>\t<why>".
#
#   skip  — a LIVE lease (another instance's OR MINE), or the shared main checkout
#   clean — nothing hydrated here
#   reap  — free or stale lease, and there is something to give back
#
# MY OWN live lease is skipped alongside a foreign one, and that is deliberate rather than an
# oversight: the rule is "never touch a tree with a live lease", and the tree I am sitting in is the
# one most likely to have a `pnpm install` or a `tsc` reading node_modules right now. `wt:steal` or
# `wt:release` is how you make your own tree reapable, and both already exist.
#
# KNOWN, AND WIDER THAN #4580's PREDICATE — tracked as #4609, read it before narrowing this:
#   · `free` is reaped as well as `stale`, and `free` means no lease was EVER taken. wt-lease.sh
#     says plainly that "Humans and CI are not gated by this file", so a worktree a HUMAN created
#     and hydrated has no lease and therefore no protection here.
#   · `stale` is not proof that nothing is running. An agent that exits while a `pnpm install` it
#     started keeps going leaves a stale lease over a live install, and this will reap under it.
# Both are the same shape: the lease answers "is an AGENT holding this tree", and this command asks
# it "is anything using these files". Narrowing to `stale` alone would not fix it and would lose
# the human-created case entirely; the fix is a liveness signal, which is #4609's job.
#
# ONE PREDICATE, OPTIONAL BYTES. `--with-bytes` decides only whether to pay for `du`; it can never
# change the verb. That split is the whole design: "is this tree reapable, and is it hydrated?" is
# a lease read plus a directory test, while the `du` exists solely to render a number in a report.
# A second, cheaper "would this be reaped?" helper would have been the fork this repo keeps getting
# bitten by — two renderers, one of which never gets the fix. So the expensive half is a parameter,
# not a copy, and if the hint and the command ever disagree it is a predicate bug that shows in both.
#
# WHY IT MATTERS: `--prune` is named in CLAUDE.md §2 as routine hygiene, and it calls this once per
# kept tree purely to COUNT them. A pause on a command people are supposed to run casually trains
# them not to run it, which costs more than the hint is worth.
#
# MEASURED, and it corrects a wrong attribution rather than confirming one. `--prune --dry-run` over
# 68 worktrees: 44s on origin/dev with NO hint at all, ~49s with it. The dominant cost is neither du
# nor this hint — it is `wt_branch_landed`, which spends one `gh` API call per tree (0.47s measured,
# x68). Over these trees the du component is inside the noise of that. So this parameter is worth
# having for its SHAPE — the cheap question stays cheap as tree counts grow, and nobody pays for a
# number they cannot read — but do not credit it with fixing a 48s command. The lever for that is
# batching or caching the PR lookups, which is older than this file's involvement.
#
# The real `--dehydrate` run does not ask for bytes either: it reports what the reap itself measured
# under the lease, so asking here would have been a second du over the same 2 GB, discarded.
wt_dehydrate_verdict() { # <worktree> [--with-bytes] → verb<TAB>bytes<TAB>why
	local wt="$1" want_bytes=0 state dirs bytes=0 n=0 d
	[ "${2:-}" = "--with-bytes" ] && want_bytes=1
	# Asked FIRST, because `git worktree list` still names a directory somebody deleted by hand, and
	# every question below it resolves a missing path to the MAIN-checkout answer — which would
	# report a deleted tree as "the shared main checkout". A true mechanism under a false label.
	if [ ! -d "$wt" ]; then
		printf 'skip\t0\tthe worktree directory is gone — run: git worktree prune\n'
		return 0
	fi
	state="$(wt_lease_state "$wt")"
	case "$state" in
		main)
			# Same safe action either way, but one of the two sentences would be false. See
			# wt_is_readable_repo — the residual of the gone-directory case above.
			if wt_is_readable_repo "$wt"; then
				printf 'skip\t0\tthe shared main checkout — it is the one tree that is meant to be hydrated\n'
			else
				printf 'skip\t0\tgit cannot read this tree (.git missing or broken) — not touching it\n'
			fi
			return 0
			;;
		live)
			printf 'skip\t0\theld by another LIVE instance (pnpm wt:who)\n'
			return 0
			;;
		mine)
			printf 'skip\t0\tyours and LIVE — release it first (pnpm wt:release) if you really mean it\n'
			return 0
			;;
	esac
	dirs="$(wt_node_modules_dirs "$wt")"
	if [ -z "$dirs" ]; then
		printf 'clean\t0\talready de-hydrated (lease %s)\n' "$state"
		return 0
	fi
	while IFS= read -r d; do
		[ -n "$d" ] || continue
		if [ "$want_bytes" = 1 ]; then bytes=$((bytes + $(wt_dir_bytes "$d"))); fi
		n=$((n + 1))
	done <<NMEOF
$dirs
NMEOF
	# The two renderings differ only in whether they can honestly name a size. A count-only verdict
	# must not carry a figure it did not measure — that is how "N trees" quietly becomes "N GB".
	if [ "$want_bytes" = 1 ]; then
		printf 'reap\t%s\tup to %s on disk across %s node_modules dir(s), lease %s\n' "$bytes" "$(wt_human_bytes "$bytes")" "$n" "$state"
	else
		printf 'reap\t0\t%s node_modules dir(s), lease %s (size not measured)\n' "$n" "$state"
	fi
}

# Would `wt:dehydrate` actually reach this tree? Used ONLY by --prune's hint line, which must not
# promise a command that will refuse: counting a live-held hydrated tree there tells the reader to
# run something that reaches neither it nor, possibly, anything at all.
#
# Asks the ONE verdict, with bytes OFF — it needs a count, not a size, and this runs once per kept
# tree on a routine command. The self-test asserts that this path invokes `du` exactly zero times.
wt_count_reachable_hydrated() { # <worktree> → 0 if wt:dehydrate would reap it
	[ "$(wt_dehydrate_verdict "$1" | cut -f1)" = reap ]
}

# Release the reap's own lock. Set as an EXIT/INT/TERM trap by wt_dehydrate_tree.
#
# The sweep calls that function inside a `$(…)` (it captures the byte figure), so the trap usually
# belongs to that subshell and fires as the reap ends. It is NOT always a subshell, though — the
# self-test calls it directly, which is exactly why wt_dehydrate_tree saves and restores the
# caller's traps. "However it ends" means every signal that CAN be trapped: SIGKILL cannot, and the
# `$$` keying is what stops that leaving a wedge (the lease reads `stale` once the script dies).
# INT/TERM handler. Releases the lock AND ENDS THE REAP — the two must happen together.
#
# A bare `trap wt_reap_unlock … INT TERM` was measurably worse than no trap at all: bash runs the
# handler and then RESUMES the interrupted command, so the lease was released while the `rm -rf`
# loop carried on. Measured with `kill -TERM` and a shimmed slow du: lease FREE at t+2s with 24 of
# 30 node_modules still being deleted over the following ~8s. That is a tree which is unlocked and
# being destroyed at the same time — the same shape as the mode-B/C defect, arriving through the
# signal path instead of the scan path, and an instance acquiring in that window would believe it
# owned a tree mid-delete.
#
# `exit` is what makes the difference; unlocking without it is the defect. The in-flight `rm -rf`
# still completes — bash defers a trap until the current foreground command returns — so this
# bounds the damage at one directory rather than at the whole set.
wt_reap_signal() { # <signal-number>
	wt_reap_unlock
	trap - EXIT INT TERM
	exit $((128 + ${1:-15}))
}

wt_reap_unlock() {
	[ -n "${WT_REAP_LOCK:-}" ] || return 0
	# No ALETHIA_ALLOW_FOREIGN_WT here: wt_lease_release never reads it. Only CLAUDE_PID matters, so
	# that wt_lease_is_mine() recognises the `$$`-stamped lease as ours and actually drops it.
	CLAUDE_PID="$$" wt_lease_release "$WT_REAP_LOCK" >/dev/null 2>&1 || true
	WT_REAP_LOCK=""
}

# Remove <worktree>'s reapable node_modules and NOTHING else.
#   0 = reaped
#   1 = REFUSED, and nothing was touched
#
# THE LOCK IS KEYED ON THIS SCRIPT'S OWN PID, not on an agent marker, and that is the whole point.
# `wt_lease_acquire` is agent-scoped BY DESIGN: it returns 0 without ever reading the lease when
# there is no agent marker (wt-lease.sh: "Humans and CI are not gated by this file") and again under
# ALETHIA_ALLOW_FOREIGN_WT=1. Calling it plainly therefore TOOK NOTHING in exactly those two modes,
# so `find` + `du` + `rm` ran with nobody holding the tree — the first audit measured the deletion,
# and a re-audit measured that adding a state re-check merely HALVED the window rather than closing
# it: a holder arriving after the check still lost its node_modules at t=5s and t=7s of an 8.2s run.
#
# So the reaper takes a REAL lease, as itself:
#
#   CLAUDE_PID="$$"                  → wt_self_pid() answers, so a lease is actually written, and
#                                      `$$` is this script, which is alive for exactly the reap.
#   ALETHIA_ALLOW_FOREIGN_WT=""      → the hatch cannot make the reaper skip its own lock. That
#                                      hatch exists to let a maintainer EDIT someone's worktree; it
#                                      was never a licence to delete under a live process.
#
# The `mkdir` inside wt_lease_acquire is the arbitration point: whoever wins it owns the tree. The
# three-modes claim is about THE REAPER — this command now takes a lock whichever way it was
# invoked, where before it took none in two of the three. It is NOT a claim about arrivals, and the
# difference matters: an arriving instance that carries ALETHIA_ALLOW_FOREIGN_WT=1 gets 0 from its
# own acquire without ever reading our lease (wt-lease.sh returns early on the hatch), so it is not
# excluded. Measured: a plain agent arriving gets rc 1, an agent arriving under the hatch gets rc 0.
# That is the hatch behaving as designed — it is the documented override — and no fixture here can
# catch it, because `_race` only ever sets the hatch on the reaper.
#
# The state read stays, BEFORE the lock, because it answers a question the lock cannot: it honours
# neither hatch and so still says "live" for a holder that is already there.
#
# ORDER MATTERS AND IS NOT INTERCHANGEABLE: state-read first, then lock. Reversed, our own `$$`
# lease would read back as a foreign `live` — wt_lease_is_mine compares against the CALLER's
# CLAUDE_PID, which is not `$$` — and the reap would refuse itself.
#
# HONEST SCOPE on that state read: now that the lock neutralises the hatch too, the acquire ALSO
# refuses every already-live tree, so the read is a cheap fail-closed early-out rather than the
# load-bearing half it was one commit ago — and deleting it leaves the suite green. It stays because
# it costs one `ps` and fails closed before any mkdir on a path whose next statement is `rm -rf`.
# Do not read its presence as evidence that the acquire alone would be unsafe.
#
# NOT CLOSED, and the residue is named: a holder that takes no lease at all (a human at a terminal,
# per wt-lease.sh's own design) is invisible to both the read and the lock. That is #4609, not this.
#
# (require_free() is the acquire with an exit() on top, which is wrong for a sweep — one held tree
# must not end the run. --prune calls wt_lease_acquire directly for exactly that reason.)
wt_dehydrate_tree() { # <worktree> → prints the bytes it removed, on stdout
	local wt="$1" d dirs bytes=0 prev_traps
	# 1. Already held? Honours neither hatch, so it answers for a human's tree too.
	case "$(wt_lease_state "$wt")" in live) return 1 ;; esac
	# 2. TAKE it, as this script rather than as an agent. Everything expensive happens after this
	#    line and is therefore covered; before this line nothing has been touched.
	ALETHIA_ALLOW_FOREIGN_WT="" CLAUDE_PID="$$" wt_lease_acquire "$wt" >/dev/null 2>&1 || return 1
	WT_REAP_LOCK="$wt"
	# An interrupted reap must not leave the tree locked for as long as this script lives. SIGKILL
	# cannot be trapped, but the lease is keyed on `$$`, so a killed reap's lease reads `stale` the
	# moment the script dies — reclaimable — rather than wedging the tree.
	#
	# The caller's traps are SAVED AND RESTORED. The production path calls this inside `$(…)`, where
	# an EXIT trap is subshell-local and harmless — but the self-test calls it directly too, and
	# there an unguarded `trap … EXIT` silently replaces the caller's cleanup and `trap -` then
	# deletes it outright. That leaks only when a direct call gets PAST this line, which today none
	# do, so it would have sat here until the arrangement changed and then leaked quietly.
	prev_traps="$(trap -p EXIT INT TERM)"
	# EXIT releases; INT/TERM release AND STOP. See wt_reap_signal — a handler that only unlocks
	# hands the next instance a tree that is unlocked and still being deleted.
	trap wt_reap_unlock EXIT
	trap 'wt_reap_signal 2' INT
	trap 'wt_reap_signal 15' TERM
	# Derive the set ONCE, under the lock, and measure THE SET WE ARE ABOUT TO DELETE. Reporting
	# the verdict's figure instead was measurably wrong: that one is taken before the lock, and
	# the set is re-derived after it — observed drift of 716800 B against a set that had shrunk in
	# between, printed as though it were what the reap gave back.
	dirs="$(wt_node_modules_dirs "$wt")"
	while IFS= read -r d; do
		[ -n "$d" ] || continue
		bytes=$((bytes + $(wt_dir_bytes "$d")))
		rm -rf "$d"
	done <<NMEOF
$dirs
NMEOF
	# Hand it straight back, and for the RIGHT reason — the previous wording here was measurably
	# false. It claimed a leftover lease makes a tree "read as LIVE-held by a process that has since
	# exited — un-reapable for everyone after". It does not: liveness is `ps` on the recorded pid, so
	# once the holder exits the state is `stale`, which is reapable.
	#
	# WHAT IT ACTUALLY COSTS, and it is wider than a worktree. While the lock is held the tree reads
	# as a LIVE FOREIGN lease to EVERY instance — including the one that ran this command, because
	# the pid is `$$` and never any agent's wt_self_pid(). Two consequences worth writing down,
	# because both are confusing when met cold:
	#   · `.claude/hooks/guard-worktree.sh` refuses `git stash` REPO-WIDE whenever any other
	#     worktree carries a live foreign lease — and git's stash stack is repo-wide, so the denial
	#     lands on every instance, not just on this tree. Measured: no lease → exit 0; the reaper's
	#     lease → exit 2 "BLOCKED: git stash uses a shared repository stack"; the same lease stamped
	#     with the caller's own CLAUDE_PID → exit 0.
	#   · require_free() tells a peer "another LIVE Claude instance is working in it … wt:steal",
	#     naming a pid that is this script and may already be gone.
	# Each is per-tree and self-clearing, but a sweep holds SOME tree for essentially its whole run.
	# The lock is what makes the reap correct, so the behaviour stands — the release is immediate
	# rather than deferred to the trap precisely to keep that window as short as possible.
	wt_reap_unlock
	trap - EXIT INT TERM
	# Restore ONLY in the caller's own shell. A `$(…)` subshell does NOT inherit-and-run the
	# parent's EXIT trap — but eval-ing it back in ARMS it, and it then fires when the substitution
	# ends. Measured, after this restore was added "defensively": the caller's cleanup trap ran at
	# the end of the reap and deleted the whole fixture, and seven downstream assertions failed for
	# reasons unrelated to their names. BASHPID is the subshell's pid, $$ is the main shell's.
	if [ "${BASHPID:-$$}" = "$$" ]; then eval "${prev_traps:-}"; fi
	printf '%s' "$bytes"
	return 0
}

# `pnpm wt:who` — the discoverability answer. Nothing used to tell you a worktree was taken until
# you had already trampled it.
if [ "${1:-}" = "--who" ]; then
	printf '%-46s %-34s %s\n' WORKTREE BRANCH HOLDER
	git worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r w; do
		[ -n "$w" ] || continue
		br="$(git -C "$w" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
		ld="$(wt_lease_dir "$w" 2>/dev/null || true)"
		# The classification is wt_lease_state()'s, not a second copy of it: `wt:dehydrate` DELETES
		# on the same five words, and a `--who` that disagreed with the reaper about which tree is
		# abandoned would be worse than no report at all. This renders it; it does not decide it.
		state="$(wt_lease_state "$w")"
		# wt_lease_state ran in a $( ) subshell, so re-read the owner here for the WT_L_* the two
		# LIVE lines print. The read is a renderer's detail; the verdict above is already decided.
		[ -n "$ld" ] && wt_lease_read "$ld" 2>/dev/null || true
		case "$state" in
			# Asked in the same order, and for the same reason, as wt_dehydrate_verdict: a
			# hand-deleted worktree that git still lists resolves to the MAIN-checkout answer
			# otherwise, so `--who` called a missing directory "the main checkout, shared" while
			# the verdict named it. Unifying these two ladders is what this hunk is for, and this
			# was the sibling of the broken-.git case, left behind.
			main)
				if [ ! -d "$w" ]; then
					who="✗ directory is gone — run: git worktree prune"
				elif wt_is_readable_repo "$w"; then
					who="— (main checkout, shared)"
				else
					who="✗ git cannot read this tree (.git missing or broken)"
				fi
				;;
			free) who="free" ;;
			stale) who="stale (holder gone) — reclaimed on next use" ;;
			mine) who="LIVE pid $WT_L_PID on $WT_L_HOST · idle $(wt_lease_idle "$ld") ← you" ;;
			*) who="LIVE pid $WT_L_PID on $WT_L_HOST · idle $(wt_lease_idle "$ld")" ;;
		esac
		printf '%-46s %-34s %s\n' "${w/#$HOME/\~}" "$br" "$who"
	done
	exit 0
fi

if [ "${1:-}" = "--release" ]; then
	target="${2:-$PWD}"
	[ -d "$target" ] || target="../wt-${2#feat/}"
	if wt_lease_release "$target"; then
		echo "✓ released $(cd "$target" && pwd -P)"
	else
		echo "✗ $target is held by another live instance — not yours to release." >&2
		exit 1
	fi
	exit 0
fi

if [ "${1:-}" = "--steal" ]; then
	name="${2:?usage: pnpm wt:steal <name>}"
	name="${name#feat/}"
	dir="../wt-${name}"
	[ -d "$dir" ] || {
		echo "✗ $dir does not exist" >&2
		exit 1
	}
	ld="$(wt_lease_dir "$dir")"
	if wt_lease_read "$ld" 2>/dev/null && wt_lease_live && ! wt_lease_is_mine; then
		echo "⚠ pid $WT_L_PID on $WT_L_HOST still looks ALIVE (idle $(wt_lease_idle "$ld"))." >&2
		echo "  Taking a live instance's worktree is how issue #1247 happened. Continuing anyway." >&2
	fi
	rm -rf "$ld"
	wt_lease_acquire "$dir" >/dev/null || true
	echo "✓ stole $dir — it is now leased to you (pid $(wt_self_pid))."
	exit 0
fi

# `pnpm wt:prune` — remove worktrees whose branch has already landed on dev.
#
# Only ever touches trees that are (a) free (no live lease), (b) clean (no uncommitted
# or untracked files), and (c) on a branch that has LANDED on origin/dev. Anything
# failing any test is REPORTED AND SKIPPED, never forced: on 2026-07-27 a sweep found a
# tree with 22 untracked .tf files that a bad scan had cleared for deletion, and the
# only thing that saved it was `git worktree remove` refusing without --force.
#
# (c) used to be a bare `git merge-base --is-ancestor`, which cannot see the squash merge
# that every dev PR lands as — so this whole command was a no-op and 30 dead trees piled
# up before anyone measured it. wt_branch_landed() answers it properly, and fails safe.
# See scripts/lib/wt-landed.sh for the rule and why clause (b) of it is load-bearing.
#
# --dry-run reports what it WOULD do and removes nothing.
if [ "${1:-}" = "--prune" ]; then
	dry=0
	[ "${2:-}" = "--dry-run" ] && dry=1
	git fetch -q origin dev 2>/dev/null || true
	base="origin/dev"
	git rev-parse --verify -q "$base" >/dev/null 2>&1 || base="dev"
	removed=0
	kept=0
	hydrated=0
	while IFS= read -r wt; do
		[ -n "$wt" ] || continue
		case "$wt" in */wt-*) ;; *) continue ;; esac
		br="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"

		# The two skips below are the shape issue #4580 measured: a tree can be simultaneously
		# ABANDONED and un-prunable, and then nothing reaches its ~2 GB of node_modules ever again.
		# Counting them here is the only thing that makes `wt:dehydrate` discoverable from the
		# command an instance already runs.
		if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
			echo "  skip  $wt  ($br) — uncommitted or untracked work"
			kept=$((kept + 1))
			wt_count_reachable_hydrated "$wt" && hydrated=$((hydrated + 1)) || true
			continue
		fi
		if ! wt_branch_landed "$wt" "$br" "$base"; then
			echo "  skip  $wt  ($br) — ${WT_LANDED_WHY}"
			kept=$((kept + 1))
			wt_count_reachable_hydrated "$wt" && hydrated=$((hydrated + 1)) || true
			continue
		fi
		if [ "$dry" = 1 ]; then
			# Read the lease instead of acquiring it: a dry run must not take ownership of
			# trees it is not going to remove.
			ld="$(wt_lease_dir "$wt" 2>/dev/null || true)"
			if [ -n "$ld" ] && wt_lease_read "$ld" 2>/dev/null && wt_lease_live && ! wt_lease_is_mine; then
				echo "  skip  $wt  ($br) — held by another live instance"
				kept=$((kept + 1))
			else
				echo "  WOULD rm  $wt  ($br) — ${WT_LANDED_WHY}"
				removed=$((removed + 1))
			fi
			continue
		fi
		if ! wt_lease_acquire "$wt" >/dev/null 2>&1; then
			echo "  skip  $wt  ($br) — held by another live instance"
			kept=$((kept + 1))
			continue
		fi
		# Deliberately no --force. If git objects, that is new information: believe it.
		if git worktree remove "$wt" 2>/dev/null; then
			echo "  rm    $wt  ($br)"
			removed=$((removed + 1))
		else
			echo "  skip  $wt  ($br) — git refused to remove it"
			kept=$((kept + 1))
			# Counted here too. This is a tree `wt:dehydrate` CAN reach — the two skips above are
			# not the only ones that leave a hydrated tree behind, and leaving this one out made
			# the hint under-report the very trees it advertises. (The two live-held skips are
			# deliberately NOT counted: dehydrate would refuse those.)
			#
			# UNFIXTURED, and not for want of trying: reaching this branch needs wt_branch_landed
			# to answer "landed", which needs `gh`. Without it the function fails safe to "not
			# landed" and the tree takes the skip above instead, so no hermetic fixture can get
			# here. The self-test cannot cover this line; #4622's batching work will have to.
			wt_count_reachable_hydrated "$wt" && hydrated=$((hydrated + 1)) || true
		fi
	done <<EOF
$(git worktree list --porcelain | sed -n 's/^worktree //p')
EOF
	echo ""
	if [ "$dry" = 1 ]; then
		echo "✓ dry run: would remove $removed, keep $kept. Nothing was touched."
	else
		git worktree prune
		echo "✓ removed $removed, kept $kept. Nothing was forced."
	fi
	if [ "$hydrated" -gt 0 ]; then
		echo "  ↳ $hydrated kept tree(s) carry node_modules that --prune cannot reach and wt:dehydrate CAN."
		echo "    pnpm wt:dehydrate --dry-run     # node_modules only; the tree and its work stay"
	fi
	exit 0
fi

# `pnpm wt:dehydrate [--dry-run]` — give back the REGENERABLE half of the worktrees nobody holds.
#
# WHY THIS IS NOT A MODE OF `--prune`, which is where issue #4580 first proposed it. The two
# commands have opposite predicates and opposite blast radii, and folding them together would put
# both behind one word:
#
#   --prune     removes the TREE, and only when the branch has LANDED and the tree is clean.
#   --dehydrate removes node_modules, and DELIBERATELY targets the trees --prune must refuse — the
#               unlanded, the dirty, the abandoned. It never removes a tree or a tracked file.
#
# So `--prune --dehydrate` would read as "prune, but gentler", one mistyped flag away from deleting
# a tree that has never landed. A separate verb keeps the destructive one destructive. --prune now
# ends by COUNTING the trees it kept that are still hydrated and naming this command, which is the
# discoverability half of the proposal and costs no blast radius.
#
# MEASURED, 2026-09-10 (#4580): five `stale (holder gone)` trees held 9.7 GB of node_modules by du
# on a laptop with 1.8 GiB free. Sweeping them — plus a `pnpm store prune` — took it to 5.5 GiB
# without removing a worktree or a line of source, and one of the five had uncommitted work, which
# survived. That is the whole design: the regenerable half goes, the irreplaceable half stays.
#
# READ THAT AGGREGATE CORRECTLY, because the per-tree version of it is false. 9.7 GB is du's figure
# and du cannot see APFS clones; one real tree reaped by hand the same day returned 52 MB against
# du's 1996 MB (see wt_dir_bytes). The gain is not "2 GB per tree" — it is that a block shared with
# the pnpm store is freed only when its LAST reference goes, and an abandoned-but-unlanded tree
# holds one of those references FOREVER because nothing else can reach it. This command exists to
# drop the last reference; `pnpm store prune` then collects what that released. Anyone told to
# expect ~2 GB back per tree will run it at 95% disk and be disappointed by a working tool.
#
# Re-hydrate with `pnpm install --frozen-lockfile` (CLAUDE.md §2 — a bare install in a worktree can
# rewrite pnpm-lock.yaml and ride the diff into an unrelated PR).
if [ "${1:-}" = "--dehydrate" ]; then
	dry=0
	# REFUSE an argument we do not understand, rather than ignoring it. The old loop only ever SET
	# `dry`, so `--dry-runn` and `-n` both fell through to the REAL reap — a typo in the safety flag
	# performing the destructive run is the worst available default for a command that deletes.
	for a in "$@"; do
		case "$a" in
			--dehydrate) ;; # our own verb
			--dry-run) dry=1 ;;
			*)
				echo "✗ wt:dehydrate: unknown argument '$a'" >&2
				echo "  usage: pnpm wt:dehydrate [--dry-run]" >&2
				echo "  Refusing rather than guessing: this command deletes, and the only flag it" >&2
				echo "  takes is the one that stops it doing so." >&2
				exit 2
				;;
		esac
	done
	total=0
	reaped=0
	held=0
	other=0
	# HELD and OTHER are counted apart because "skipping N held one(s)" was false: it lumped the
	# main checkout, a tree git cannot read and a directory that no longer exists in with trees a
	# live instance is actually working in. In a four-worktree fixture two of the four "held" were
	# held by nothing at all.
	#
	# No `*/wt-*` name filter, unlike --prune: the main checkout is excluded because wt_lease_dir
	# says it is not leasable, which is the actual question. The harness also creates worktrees at
	# app/.claude/worktrees/<name>, and those are just as reapable as a sibling wt-*.
	while IFS= read -r wt; do
		[ -n "$wt" ] || continue
		br="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
		# Bytes ONLY on a dry run: a ceiling is the dry run's whole product, while the real run
		# reports what the reap itself measured under the lease — asking here would be a second du
		# over the same 2 GB, discarded.
		if [ "$dry" = 1 ]; then
			verdict="$(wt_dehydrate_verdict "$wt" --with-bytes)"
		else
			verdict="$(wt_dehydrate_verdict "$wt")"
		fi
		verb="${verdict%%$'\t'*}"
		rest="${verdict#*$'\t'}"
		bytes="${rest%%$'\t'*}"
		why="${rest#*$'\t'}"
		case "$verb" in
			skip)
				echo "  skip  $wt  ($br) — $why"
				# Only a LIVE lease means "held". The other skips are "not a target".
				case "$why" in
					*LIVE\ instance* | *yours\ and\ LIVE*) held=$((held + 1)) ;;
					*) other=$((other + 1)) ;;
				esac
				continue
				;;
			clean)
				echo "  ok    $wt  ($br) — $why"
				continue
				;;
		esac
		if [ "$dry" = 1 ]; then
			echo "  WOULD reap  $wt  ($br) — $why"
		elif freed="$(wt_dehydrate_tree "$wt")"; then
			# The REAP's own figure, not the verdict's: the verdict measured before the lease was
			# taken and the set was re-derived after it.
			bytes="$freed"
			echo "  reap  $wt  ($br) — freed up to $(wt_human_bytes "$bytes") on disk"
		else
			echo "  skip  $wt  ($br) — a live instance took it between the scan and the reap"
			held=$((held + 1))
			continue
		fi
		total=$((total + bytes))
		reaped=$((reaped + 1))
		# `sed -n 's/^worktree //p'`, never `awk '{print $2}'`: awk splits on whitespace and so
		# truncates any worktree path containing a space, handing a TRUNCATED PATH to a function
		# that deletes. Both forms were already in this file; --who had the right one.
	done <<EOF
$(git worktree list --porcelain | sed -n 's/^worktree //p')
EOF
	echo ""
	if [ "$dry" = 1 ]; then
		echo "✓ dry run: would reap $reaped tree(s), up to $(wt_human_bytes "$total") on disk; $held held by a live instance, $other not a target. Nothing was touched."
		echo "  \"up to\" is the ceiling, not the estimate: pnpm uses APFS clones, so most of these"
		echo "  blocks are shared with the pnpm store and expect FAR less back — 38x less, measured."
	else
		echo "✓ reaped $reaped tree(s), up to $(wt_human_bytes "$total") on disk; $held held by a live instance, $other not a target."
		echo "  No worktree, tracked file or uncommitted change was removed. A reaped tree's own"
		echo "  stale lease record goes with it, so it reads 'free' rather than 'stale' afterwards."
		echo ""
		echo "  \"up to\" is the honest form, not a hedge. pnpm uses APFS clones, so most of what was"
		echo "  just deleted was SHARED with the pnpm store, and a block is freed only when its last"
		echo "  reference goes. Measured on one real tree: du said 1996 MB, df moved 52 MB — 38x."
		echo "  That is the point of the sweep rather than an argument against it: dropping the last"
		echo "  reference is the only thing that frees the shared blocks, and an abandoned tree holds"
		echo "  one forever. Collect what this released:   pnpm store prune"
		echo "  What you actually got back:                df -h /"
		echo "  Re-hydrate one when a generator needs it:  pnpm install --frozen-lockfile"
	fi
	exit 0
fi

# ── self-test ───────────────────────────────────────────────────────────────────────────────────
#
# Hermetic: builds a throwaway repo + linked worktree under mktemp and reaps THAT. It never reads,
# and cannot reach, a real worktree.
#
# The destructive path is exercised for real rather than described, because every property worth
# having here is a property of what SURVIVES: an uncommitted edit, an untracked file, a tracked file
# force-added inside an ignored node_modules, and a node_modules git does not ignore. A test that
# only checked what was deleted would pass on a reaper that deleted the whole tree.
#
# The counter lives in this function's scope and every assertion runs in it — NOT inside `( … )` or
# a pipeline. A self-test that increments `fails` in a subshell prints FAIL and then summarises
# "all passed", which is a report, not a test. Mutate something and watch the EXIT CODE.
wt_dehydrate_self_test() {
	local fails=0 tmp wt ld me out bytes nl_dir reaped_bytes
	_a() { if [ "$1" = "$2" ]; then echo "ok   - $3"; else
		echo "FAIL - $3: want '$1' got '$2'" >&2
		fails=$((fails + 1))
	fi; }
	# `_absent` prints the whole listing when it fails: a boolean about a structure that reports
	# only "false" sends the next reader back to reproduce it by hand.
	_absent() { if wt_node_modules_dirs "$wt" | grep -q -- "$1"; then
		echo "FAIL - $2: '$1' was listed. Got:" >&2
		wt_node_modules_dirs "$wt" >&2
		fails=$((fails + 1))
	else echo "ok   - $2"; fi; }
	_exists() { _a "yes" "$([ -e "$wt/$1" ] && echo yes || echo no)" "$2"; }
	_gone() { _a "no" "$([ -e "$wt/$1" ] && echo yes || echo no)" "$2"; }

	me="$$"
	tmp="$(mktemp -d)"
	# EXIT, not RETURN: with `set -e` armed (see the dispatch below) a failing assertion aborts the
	# PROCESS rather than returning, and a RETURN trap would never fire to clean up.
	# Double-quoted so the path is baked in NOW: the trap runs in the main shell, after this
	# function's `local tmp` has gone out of scope, where `set -u` would kill it on `$tmp`.
	# shellcheck disable=SC2064  # deliberate: expand at trap-set time, not at trap-fire time.
	trap "chmod -R u+rwX '$tmp' 2>/dev/null || true; rm -rf '$tmp'" EXIT
	wt="$tmp/wt-fixture"

	git init -q "$tmp/main"
	# `node_modules`, with NO trailing slash — copied from the real repo's .gitignore:4, not invented.
	# The difference is not cosmetic. `node_modules/` matches DIRECTORIES ONLY, so it silently
	# refuses a SYMLINK named node_modules and any not-yet-existing relative path — which made
	# check-ignore mask the `-type d` and under-the-worktree guards, and left both unkillable by
	# mutation while the fixture looked thorough. A fixture must be CAPTURED, not composed.
	# `!/vendored/…` re-includes one node_modules, which is how the "git does not ignore it" arm
	# gets a subject. Contrived on purpose: the guard must not rest on the directory's NAME.
	printf 'node_modules\n!/vendored/node_modules\n' >"$tmp/main/.gitignore"
	git -C "$tmp/main" add .gitignore
	git -C "$tmp/main" -c user.email=t@t -c user.name=t commit -q -m init
	git -C "$tmp/main" worktree add -q -b wtdehydrate "$wt" 2>/dev/null

	mkdir -p "$wt/node_modules/.pnpm/pkg/node_modules" "$wt/apps/console/node_modules" \
		"$wt/vendored/node_modules" "$wt/tools/node_modules" "$wt/keep"
	# ~512 KiB apiece, so `du -sk` has something real to report and the sum is a real sum.
	dd if=/dev/zero of="$wt/node_modules/blob" bs=1024 count=512 2>/dev/null
	dd if=/dev/zero of="$wt/apps/console/node_modules/blob" bs=1024 count=512 2>/dev/null
	: >"$wt/node_modules/.pnpm/pkg/node_modules/nested"
	: >"$wt/vendored/node_modules/index.js"
	: >"$wt/tools/node_modules/vendored.js"
	printf 'source\n' >"$wt/keep/app.ts"
	git -C "$wt" add keep/app.ts
	git -C "$wt" add -f tools/node_modules/vendored.js
	git -C "$wt" -c user.email=t@t -c user.name=t commit -q -m src
	# The two irreplaceable things --prune can never clear a tree of, and the reason this command
	# reaps node_modules instead of worktrees.
	printf 'uncommitted\n' >>"$wt/keep/app.ts"
	printf 'untracked\n' >"$wt/keep/scratch.txt"
	ld="$(wt_lease_dir "$wt")"

	# ── the walk ───────────────────────────────────────────────────────────────────────────────
	out="$(wt_node_modules_dirs "$wt" | sed "s#^$wt/##" | tr '\n' ' ')"
	_a "apps/console/node_modules node_modules " "$out" "walk: lists every disposable node_modules, sorted, and nothing else"
	_absent '\.pnpm' "walk: a node_modules INSIDE a node_modules is pruned, not listed twice"
	_absent '/vendored/' "walk: a node_modules .gitignore does NOT cover is refused"
	_absent '/tools/' "walk: an ignored node_modules that TRACKS a file is refused (--no-index cannot see this)"

	# An unreadable directory must cost that tree nothing: the same listing, a usable total, and a
	# verdict rather than none. Under `set -o pipefail` both find and du exit 1 on one they cannot
	# read — measured with `chmod 000` — while still producing correct output.
	#
	# HONEST SCOPE: these arms pin the RESULT, not the `set -e` abort the `|| true` guards prevent.
	# Every caller reaches those functions through a command substitution, and bash clears -e inside
	# one, so no fixture reachable from here can fail on a build with those guards removed. Stated
	# rather than left implied, because an arm that reads like it covers the guard is worse than no
	# arm: the next reader deletes the guard, watches this stay green, and believes it.
	#
	# TWO subjects, because the two pipelines fail on different inputs: `find` prunes AT a
	# node_modules and so only ever trips over an unreadable dir OUTSIDE one, while `du` is pointed
	# at a node_modules and only ever trips over one INSIDE. One fixture would exercise only one.
	#
	# The hazard is CONFIRMED reproducible before anything is asserted, because root can read a
	# chmod-000 directory and would otherwise turn both arms green for the wrong reason.
	mkdir -p "$wt/locked" "$wt/node_modules/locked"
	chmod 000 "$wt/locked" "$wt/node_modules/locked" 2>/dev/null || true
	if find "$wt/locked" -type d -print >/dev/null 2>&1; then
		echo "ok   - (not applicable) unreadable-dir arms: this user can read a chmod-000 dir"
	else
		_a "2" "$(wt_node_modules_dirs "$wt" | wc -l | tr -d ' ')" "walk: an unreadable dir beside a node_modules does not abort the sweep (pipefail)"
		if [ "$(wt_dir_bytes "$wt/node_modules")" -gt 0 ]; then echo "ok   - size: an unreadable dir INSIDE a node_modules still yields a total (pipefail)"; else
			echo "FAIL - size: an unreadable dir inside a node_modules yielded no total" >&2
			fails=$((fails + 1))
		fi
		_a "reap" "$(CLAUDE_PID="$me" wt_dehydrate_verdict "$wt" | cut -f1)" "verdict: … and the tree still gets a verdict rather than none"
	fi
	chmod 755 "$wt/locked" "$wt/node_modules/locked" 2>/dev/null || true
	rm -rf "$wt/locked" "$wt/node_modules/locked"

	# ── the three guards inside the DELETING function that nothing else pins ────────────────────
	#
	# `-type d`. The comment on the walk makes a SAFETY CLAIM about deletion — "a symlinked
	# node_modules is skipped: the safe direction" — and a safety claim with nothing keeping it true
	# is the defect class this repo keeps rediscovering. Without `-type d`, `-name node_modules`
	# matches the LINK, and `rm -rf` on it removes the link out of a tree we were asked not to alter.
	mkdir -p "$tmp/outside-target"
	: >"$tmp/outside-target/keep-me"
	ln -s "$tmp/outside-target" "$wt/apps/node_modules"
	_absent '/apps/node_modules$' "walk: a SYMLINKED node_modules is skipped (-type d), not followed and not deleted"
	_a "yes" "$([ -e "$tmp/outside-target/keep-me" ] && echo yes || echo no)" "walk: … and what it points at is untouched"

	# `-name .git -prune`. Asked of the fixture's MAIN checkout, the only tree here whose .git is a
	# directory rather than a file — which is exactly where a node_modules under .git could hide.
	mkdir -p "$tmp/main/.git/node_modules"
	if wt_node_modules_dirs "$tmp/main" | grep -q '/\.git/'; then
		echo "FAIL - walk: a node_modules under .git was listed" >&2
		fails=$((fails + 1))
	else echo "ok   - walk: .git is pruned, so no node_modules under it is ever a target"; fi
	rmdir "$tmp/main/.git/node_modules"

	# `[ "$rel" != "$d" ] || continue`. A directory name containing a NEWLINE makes find emit two
	# lines, and `read -r` hands the second one over as a RELATIVE fragment ("ird/node_modules").
	# Without the guard, check-ignore matches it by pattern, ls-files finds nothing tracked, and the
	# function returns a relative path — which `rm -rf` would then resolve against the SCRIPT's cwd,
	# not the worktree. That is a delete outside the tree entirely.
	nl_dir="$(printf 'we\nird')"
	mkdir -p "$wt/$nl_dir/node_modules"
	if wt_node_modules_dirs "$wt" | grep -qv "^$wt/"; then
		echo "FAIL - walk: emitted a path that is not under the worktree. Got:" >&2
		wt_node_modules_dirs "$wt" >&2
		fails=$((fails + 1))
	else echo "ok   - walk: a newline in a directory name cannot yield a relative path to rm -rf"; fi
	rm -rf "${wt:?}/${nl_dir:?}"

	# ── sizing ─────────────────────────────────────────────────────────────────────────────────
	bytes="$(($(wt_dir_bytes "$wt/node_modules") + $(wt_dir_bytes "$wt/apps/console/node_modules")))"
	if [ "$bytes" -ge 1048576 ]; then echo "ok   - size: du reports real bytes (two ~512 KiB dirs sum to $(wt_human_bytes "$bytes"))"; else
		echo "FAIL - size: two ~512 KiB dirs summed to only $bytes bytes" >&2
		fails=$((fails + 1))
	fi
	_a "0" "$(wt_dir_bytes "$tmp/no-such-dir")" "size: a missing dir is 0, not a dead sweep"
	_a "0B" "$(wt_human_bytes 0)" "human: zero"
	_a "1023B" "$(wt_human_bytes 1023)" "human: just under a KiB stays bytes"
	_a "1.0K" "$(wt_human_bytes 1024)" "human: KiB boundary"
	_a "1.0M" "$(wt_human_bytes 1048576)" "human: MiB boundary"
	_a "1.9G" "$(wt_human_bytes 2040109465)" "human: GiB to one decimal (#4580's 1.9G)"
	_a "0B" "$(wt_human_bytes not-a-number)" "human: garbage is 0B, never a crash mid-sweep"

	# ── the lock, observed with TWO PROCESSES ──────────────────────────────────────────────────
	#
	# The property no single-process fixture can reach, and the one the whole function exists for:
	# WHILE A REAP IS RUNNING, an instance arriving mid-flight must be refused — in ALL THREE modes,
	# not only when an agent happens to be driving. Before the lock was keyed on `$$`, a re-audit
	# measured the arriving holder getting rc 0 in modes B and C *and* losing its node_modules: both
	# sides believed they owned the tree. That is what this asserts against.
	#
	# The reap is slowed by a shimmed `du` so the window is real rather than hoped for; the holder
	# is a genuine second process with its own live CLAUDE_PID.
	# shellcheck disable=SC2016  # $$/$1/$2 belong to the GENERATED script and must not expand here:
	# the holder's identity has to be its own live pid, not this shell's.
	printf '#!/usr/bin/env bash\nset -u\n. "%s"\nCLAUDE_PID=$$ wt_lease_acquire "$1" >/dev/null 2>&1\necho "$?" >"$2"\n' \
		"$(cd "$(dirname "$0")" && pwd)/lib/wt-lease.sh" >"$tmp/holder.sh"
	chmod +x "$tmp/holder.sh"
	printf '#!/bin/sh\nsleep 1\nexec %s "$@"\n' "$(command -v du)" >"$tmp/shim-slow-du"
	chmod +x "$tmp/shim-slow-du"

	# <start> is `free` or `stale`, and testing both is not padding: `stale` is the population this
	# command exists for, and it takes a DIFFERENT path through wt_lease_acquire — the reclaim
	# branch, which rm -rf's the old lease before re-mkdir'ing rather than winning a fresh mkdir.
	# Every arm used to rm -rf the lease first, so all three tested `free` and none tested the one
	# that matters.
	_race() { # <label> <free|stale> <env…> — runs a reap in the background, races a holder into it
		local label="$1" start="$2"
		shift 2
		mkdir -p "$wt/node_modules" "$wt/apps/console/node_modules"
		: >"$wt/node_modules/blob"
		: >"$wt/apps/console/node_modules/blob"
		rm -rf "$ld"
		if [ "$start" = stale ]; then
			mkdir -p "$ld"
			{
				echo "pid: 999999"
				echo "procStart: Thu Jan  1 00:00:00 1970"
				echo "host: $(wt_host)"
			} >"$ld/owner"
		fi
		rm -f "$tmp/holder.rc"
		local slow="$tmp/slowdu"
		mkdir -p "$slow"
		cp "$tmp/shim-slow-du" "$slow/du"
		# shellcheck disable=SC2016  # $0/$1 are the CHILD's positional args, passed after the -c.
		( PATH="$slow:$PATH" env "$@" bash -c '. "$0"; wt_dehydrate_tree "$1" >/dev/null 2>&1' "$tmp/fns.sh" "$wt" ) &
		local reap_pid=$!
		# HANDSHAKE, not a sleep. The assertion needs the holder to arrive strictly inside the
		# reap's lock window, and that window opens only after the child has spawned bash and
		# sourced two files — a hard-coded delay is a flake in a required check. Poll the observable
		# state instead, and FAIL LOUDLY if the window never opened rather than testing nothing.
		local waited=0
		while [ "$(CLAUDE_PID="$me" wt_lease_state "$wt")" != live ] && [ "$waited" -lt 200 ]; do
			sleep 0.05
			waited=$((waited + 1))
		done
		if [ "$waited" -ge 200 ]; then
			echo "FAIL - lock: never observed the reaper's lock ($label, from $start) — the rig did not open the window, so this arm asserted nothing" >&2
			fails=$((fails + 1))
			wait "$reap_pid" 2>/dev/null || true
			return 0
		fi
		"$tmp/holder.sh" "$wt" "$tmp/holder.rc"
		wait "$reap_pid" 2>/dev/null || true
		local rc
		rc="$(cat "$tmp/holder.rc" 2>/dev/null || echo "?")"
		if [ "$rc" = 1 ]; then echo "ok   - lock: an instance arriving mid-reap is refused ($label, from $start)"; else
			echo "FAIL - lock: an instance arriving mid-reap got rc '$rc', not 1 ($label, from $start) — both sides think they own the tree" >&2
			fails=$((fails + 1))
		fi
	}
	# The functions under test, extracted so a child process can source them without the dispatch.
	sed -n '/^wt_is_readable_repo() {/,$p' "$0" | sed -n '1,/^wt_dehydrate_self_test() {/p' | sed '$d' >"$tmp/fns.sh"
	printf '. "%s"\n' "$(cd "$(dirname "$0")" && pwd)/lib/wt-lease.sh" | cat - "$tmp/fns.sh" >"$tmp/fns2.sh"
	mv "$tmp/fns2.sh" "$tmp/fns.sh"
	if bash -c '. "$0"; type wt_dehydrate_tree >/dev/null 2>&1' "$tmp/fns.sh"; then
		_race "mode A: an agent" free CLAUDE_PID="$me"
		_race "mode B: a HUMAN, no agent marker" free CLAUDE_PID= CODEX_PID= CODEX_SESSION_ID= CODEX_THREAD_ID=
		_race "mode C: ALETHIA_ALLOW_FOREIGN_WT=1" free CLAUDE_PID="$me" ALETHIA_ALLOW_FOREIGN_WT=1
		_race "mode A: an agent" stale CLAUDE_PID="$me"
		_race "mode B: a HUMAN, no agent marker" stale CLAUDE_PID= CODEX_PID= CODEX_SESSION_ID= CODEX_THREAD_ID=
		_race "mode C: ALETHIA_ALLOW_FOREIGN_WT=1" stale CLAUDE_PID="$me" ALETHIA_ALLOW_FOREIGN_WT=1
	else
		echo "FAIL - lock: could not extract the functions for the two-process race" >&2
		fails=$((fails + 1))
	fi
	rm -rf "$tmp/slowdu"
	# Put the fixture back for everything downstream.
	rm -rf "$ld" "$wt/node_modules" "$wt/apps/console/node_modules"
	mkdir -p "$wt/node_modules/.pnpm/pkg/node_modules" "$wt/apps/console/node_modules"
	dd if=/dev/zero of="$wt/node_modules/blob" bs=1024 count=512 2>/dev/null
	dd if=/dev/zero of="$wt/apps/console/node_modules/blob" bs=1024 count=512 2>/dev/null
	: >"$wt/node_modules/.pnpm/pkg/node_modules/nested"

	# ── a signal must STOP the reap, not merely unlock it ──────────────────────────────────────
	#
	# A handler that only released the lock left the tree UNLOCKED AND STILL BEING DELETED: bash
	# runs a trap and then resumes the interrupted command. Measured at 24 of 30 node_modules still
	# going after the lease read free. Both halves are asserted, because either alone passes on the
	# defect — "lease released" was already true of the broken version.
	# Its OWN repo, for the third time in this file and for the third same reason: run against the
	# shared fixture, the reap's SORTED walk reached that tree's real node_modules first and ate
	# them, and two later assertions failed naming something else entirely.
	local sig="$tmp/sigrepo"
	mkdir -p "$sig/main"
	git init -q "$sig/main"
	printf 'node_modules\n' >"$sig/main/.gitignore"
	git -C "$sig/main" add .gitignore
	git -C "$sig/main" -c user.email=t@t -c user.name=t commit -q -m init
	git -C "$sig/main" worktree add -q -b sigwt "$sig/wt-sig"
	local i
	for i in 1 2 3 4 5 6; do
		mkdir -p "$sig/wt-sig/p$i/node_modules"
		: >"$sig/wt-sig/p$i/node_modules/blob"
	done
	mkdir -p "$tmp/slowdu2"
	cp "$tmp/shim-slow-du" "$tmp/slowdu2/du" # 1s per node_modules, so the loop is interruptible
	( PATH="$tmp/slowdu2:$PATH" CLAUDE_PID="$me" bash -c '. "$0"; wt_dehydrate_tree "$1" >/dev/null 2>&1' "$tmp/fns.sh" "$sig/wt-sig" ) &
	local sig_pid=$! sig_waited=0
	while [ "$(CLAUDE_PID="$me" wt_lease_state "$sig/wt-sig")" != live ] && [ "$sig_waited" -lt 200 ]; do
		sleep 0.05
		sig_waited=$((sig_waited + 1))
	done
	if [ "$sig_waited" -ge 200 ]; then
		echo "FAIL - signal: never observed the lock, so this arm asserted nothing" >&2
		fails=$((fails + 1))
		kill "$sig_pid" 2>/dev/null || true
	else
		sleep 2.5 # let it delete a couple, so "stopped early" is distinguishable from "never ran"
		kill -TERM "$sig_pid" 2>/dev/null || true
		wait "$sig_pid" 2>/dev/null || true
		local left
		left="$(find "$sig/wt-sig" -type d -name node_modules 2>/dev/null | wc -l | tr -d ' ')"
		# BOTH bounds. `left > 0` is the fix; `left < 6` proves the reap was actually running, so
		# the arm cannot pass by the loop never having started.
		if [ "$left" -gt 0 ] && [ "$left" -lt 6 ]; then
			echo "ok   - signal: SIGTERM stopped the delete loop mid-way ($left of 6 node_modules never touched)"
		else
			echo "FAIL - signal: $left of 6 node_modules left — wanted some deleted and some spared" >&2
			fails=$((fails + 1))
		fi
		_a "free" "$(CLAUDE_PID="$me" wt_lease_state "$sig/wt-sig")" "signal: … and the lock was released on the way out"
	fi
	rm -rf "$sig" "$tmp/slowdu2"

	# ── the cost of the ONE predicate, counted rather than timed ───────────────────────────────
	#
	# NOT a timing assertion — those are flaky by construction and would be disabled within a month.
	# What actually regressed `--prune` (48s over 68 trees, on a command CLAUDE.md §2 calls routine
	# hygiene) was PAYING for du where nobody reads the number. A count of du invocations is the
	# durable form of that, and it fails for the right reason if someone reintroduces the cost.
	#
	# The shim resolves the real du BEFORE it is put on PATH, so it cannot recurse into itself.
	mkdir -p "$tmp/shim"
	printf '#!/bin/sh\necho call >>"%s"\nexec %s "$@"\n' "$tmp/du.calls" "$(command -v du)" >"$tmp/shim/du"
	chmod +x "$tmp/shim/du"
	_du_calls() { # <label> <expected: 0 | some> <verdict args…>
		local label="$1" expect="$2"
		shift 2
		: >"$tmp/du.calls"
		PATH="$tmp/shim:$PATH" "$@" >/dev/null 2>&1 || true
		local n
		n="$(wc -l <"$tmp/du.calls" | tr -d ' ')"
		if { [ "$expect" = 0 ] && [ "$n" -eq 0 ]; } || { [ "$expect" = some ] && [ "$n" -gt 0 ]; }; then
			echo "ok   - $label (du ran $n time(s))"
		else
			echo "FAIL - $label: wanted $expect du invocations, got $n" >&2
			fails=$((fails + 1))
		fi
	}
	# shellcheck disable=SC2329
	_v_plain() { CLAUDE_PID="$me" wt_dehydrate_verdict "$wt"; }
	# shellcheck disable=SC2329
	_v_bytes() { CLAUDE_PID="$me" wt_dehydrate_verdict "$wt" --with-bytes; }
	# shellcheck disable=SC2329
	_v_hint() { CLAUDE_PID="$me" wt_count_reachable_hydrated "$wt"; }
	_du_calls "cost: the default verdict never runs du" 0 _v_plain
	_du_calls "cost: --prune's hint predicate never runs du" 0 _v_hint
	_du_calls "cost: --with-bytes does run du — the ceiling is the dry run's product" some _v_bytes
	# Same predicate either way. If these ever disagree it is a predicate bug, and it shows in both.
	_a "$(CLAUDE_PID="$me" wt_dehydrate_verdict "$wt" | cut -f1)" \
		"$(CLAUDE_PID="$me" wt_dehydrate_verdict "$wt" --with-bytes | cut -f1)" \
		"cost: --with-bytes changes the FIGURE, never the verdict"
	# A count-only verdict must not carry a size it did not measure.
	if CLAUDE_PID="$me" wt_dehydrate_verdict "$wt" | cut -f3 | grep -q 'up to'; then
		echo "FAIL - cost: the byte-less verdict quoted a size it never measured" >&2
		fails=$((fails + 1))
	else echo "ok   - cost: the byte-less verdict names a count, never a size"; fi

	# ── the verdict ladder ─────────────────────────────────────────────────────────────────────
	rm -rf "$ld"
	_a "reap" "$(CLAUDE_PID="$me" wt_dehydrate_verdict "$wt" | cut -f1)" "verdict: an unleased tree is reaped"
	mkdir -p "$ld"
	{
		echo "pid: 999999"
		echo "procStart: Thu Jan  1 00:00:00 1970"
		echo "host: $(wt_host)"
	} >"$ld/owner"
	_a "reap" "$(CLAUDE_PID="$me" wt_dehydrate_verdict "$wt" | cut -f1)" "verdict: a STALE lease is reaped — the abandoned tree is the whole point"
	# pid 1 is always alive and is never us. This arm is asserted SEPARATELY from the reap below,
	# because the reap re-asks the question through wt_lease_acquire and would keep the tree safe
	# even if the verdict said 'reap' — which is exactly how a hole here stays invisible.
	{
		echo "pid: 1"
		echo "procStart: $(wt_procstart 1)"
		echo "host: $(wt_host)"
	} >"$ld/owner"
	_a "skip" "$(CLAUDE_PID="$me" wt_dehydrate_verdict "$wt" | cut -f1)" "verdict: a LIVE foreign lease is never a target"
	{
		echo "pid: $me"
		echo "procStart: $(wt_procstart "$me")"
		echo "host: $(wt_host)"
	} >"$ld/owner"
	_a "skip" "$(CLAUDE_PID="$me" wt_dehydrate_verdict "$wt" | cut -f1)" "verdict: MY OWN live lease is skipped too — a build here may be reading it"
	_a "skip" "$(CLAUDE_PID="$me" wt_dehydrate_verdict "$tmp/main" | cut -f1)" "verdict: the main checkout is never a target"
	# A path git still lists but nobody has: it must NOT fall through to the main-checkout answer.
	_a "the worktree directory is gone — run: git worktree prune" \
		"$(CLAUDE_PID="$me" wt_dehydrate_verdict "$tmp/deleted-by-hand" | cut -f3)" \
		"verdict: a worktree whose directory is gone says so, not 'the main checkout'"
	# And the residual of that: a directory git cannot read. `wt_lease_dir` answers "not leasable"
	# for the shared main checkout AND for a broken .git, and a broken .git is what an abandoned
	# tree has. The action is the same; the SENTENCE must not be.
	mkdir -p "$tmp/broken-git"
	_a "git cannot read this tree (.git missing or broken) — not touching it" \
		"$(CLAUDE_PID="$me" wt_dehydrate_verdict "$tmp/broken-git" | cut -f3)" \
		"verdict: a tree git cannot read says so, not 'the shared main checkout'"

	# ── and the SAME sentence in `--who`, which is a separate call site ────────────────────────
	#
	# The verdict got this fix first and `--who` went on calling a corpse "the main checkout" a
	# hundred lines above it. Driven as a SUBPROCESS, because the rendering lives inline in the
	# --who branch: an assertion on wt_is_readable_repo alone would pass while the call site stayed
	# wrong, which is exactly how the asymmetry survived the first pass.
	#
	# ITS OWN THROWAWAY REPO, deliberately. Building it inside $tmp/main — the repo every other
	# fixture here hangs off — destroyed the main fixture worktree: `git worktree add` prunes as it
	# goes, and seven downstream assertions then passed or failed for reasons that had nothing to do
	# with what they name. A fixture that mutates the shared fixture is fragile by construction, and
	# the `_gone` helpers hid it: "node_modules is gone" is vacuously true when the whole tree is.
	local who="$tmp/whorepo"
	mkdir -p "$who/main/scripts/lib"
	git init -q "$who/main"
	git -C "$who/main" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
	cp "$0" "$who/main/scripts/worktree.sh"
	cp "$(cd "$(dirname "$0")" && pwd)/lib/"*.sh "$who/main/scripts/lib/"
	git -C "$who/main" worktree add -q -b whobroken "$who/wt-broken"
	printf 'gitdir: /nonexistent/broken\n' >"$who/wt-broken/.git"
	# …and the sibling case: a worktree git still LISTS whose directory somebody deleted by hand.
	# The verdict asks `[ ! -d ]` before anything else precisely so this is named; --who resolved it
	# to the main-checkout answer instead. Unifying the two ladders is what that hunk is for.
	git -C "$who/main" worktree add -q -b whogone "$who/wt-gone"
	rm -rf "$who/wt-gone"
	out="$(bash "$who/main/scripts/worktree.sh" --who 2>/dev/null || true)"
	if printf '%s' "$out" | grep -F 'wt-gone' | grep -q 'directory is gone'; then
		echo "ok   - who: a worktree whose directory is gone is named, not called 'the main checkout'"
	else
		echo "FAIL - who: a gone directory rendered as:" >&2
		printf '%s\n' "$out" | grep -F 'wt-gone' >&2 || echo "  (no wt-gone line at all)" >&2
		fails=$((fails + 1))
	fi
	if printf '%s' "$out" | grep -F 'wt-broken' | grep -q 'git cannot read'; then
		echo "ok   - who: a broken .git is named, not called 'the main checkout'"
	else
		echo "FAIL - who: a broken .git rendered as:" >&2
		printf '%s\n' "$out" | grep -F 'wt-broken' >&2 || echo "  (no wt-broken line at all)" >&2
		fails=$((fails + 1))
	fi
	# The other direction, so the fix cannot be "relabel every unleasable tree".
	if printf '%s' "$out" | grep -F "$who/main" | grep -q 'main checkout, shared'; then
		echo "ok   - who: the REAL main checkout still reads as the main checkout"
	else
		echo "FAIL - who: the real main checkout stopped rendering as one" >&2
		fails=$((fails + 1))
	fi
	rm -rf "$who"
	# The shared fixture must be exactly as it was. Asserted, not assumed — that is the bug above.
	_a "wtdehydrate" "$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo GONE)" \
		"who: the --who fixture left the shared fixture worktree untouched"

	# ── the reap itself ────────────────────────────────────────────────────────────────────────
	{
		echo "pid: 1"
		echo "procStart: $(wt_procstart 1)"
		echo "host: $(wt_host)"
	} >"$ld/owner"
	# THREE invocation modes, because `wt_lease_acquire` answers 0 ("proceed") without ever looking
	# at the lease in two of them — no agent marker, and ALETHIA_ALLOW_FOREIGN_WT=1 — and 0 is what
	# the reap reads as "I own it, delete". Mode B is the maintainer at 94% disk typing
	# `pnpm wt:dehydrate` in their own terminal, which is the person this command was written for.
	# `shift` before running: passing the label through to "$@" runs the LABEL as a command, which
	# exits 127 and so reports "refused" for every mode — three arms passing for the wrong reason.
	# (Caught by mutating the implementation and watching them stay green.)
	_held() { # <label> <wrapper-fn>
		local label="$1"
		shift
		if "$@"; then
			echo "FAIL - reap: a LIVE foreign lease did NOT stop the reap ($label)" >&2
			fails=$((fails + 1))
		else echo "ok   - reap: a LIVE foreign lease stops the reap ($label)"; fi
	}
	# Wrappers rather than inline env prefixes, so `_held` can take the invocation by NAME and the
	# label cannot end up in the command. shellcheck cannot see an indirect call.
	# shellcheck disable=SC2329
	_mode_a() { CLAUDE_PID="$me" wt_dehydrate_tree "$wt"; }
	# shellcheck disable=SC2329
	_mode_b() { CLAUDE_PID="" CODEX_PID="" CODEX_SESSION_ID="" CODEX_THREAD_ID="" wt_dehydrate_tree "$wt"; }
	# shellcheck disable=SC2329
	_mode_c() { CLAUDE_PID="$me" ALETHIA_ALLOW_FOREIGN_WT=1 wt_dehydrate_tree "$wt"; }
	_held "mode A: an agent" _mode_a
	_exists "node_modules/blob" "reap: … and the held tree's node_modules is still there (mode A)"
	_held "mode B: a HUMAN, no agent marker" _mode_b
	_exists "node_modules/blob" "reap: … and the held tree's node_modules is still there (mode B)"
	_held "mode C: ALETHIA_ALLOW_FOREIGN_WT=1" _mode_c
	_exists "node_modules/blob" "reap: … and the held tree's node_modules is still there (mode C)"
	# The hatch must not leave a foreign lease looking reaped-and-released either.
	_a "live" "$(CLAUDE_PID="$me" wt_lease_state "$wt")" "reap: a refused tree keeps its holder's lease untouched"

	{
		echo "pid: 999999"
		echo "procStart: Thu Jan  1 00:00:00 1970"
		echo "host: $(wt_host)"
	} >"$ld/owner"
	# Capture what the reap REPORTS, not what the scan predicted: the printed figure is the tool's
	# entire justification, and it is derived under the lease from the set actually deleted.
	reaped_bytes=""
	if reaped_bytes="$(CLAUDE_PID="$me" wt_dehydrate_tree "$wt")"; then echo "ok   - reap: a stale lease is reclaimed and the tree reaped"; else
		echo "FAIL - reap: a stale lease blocked the reap" >&2
		fails=$((fails + 1))
	fi
	if [ "${reaped_bytes:-0}" -ge 1048576 ]; then echo "ok   - reap: reports the bytes IT removed ($(wt_human_bytes "$reaped_bytes")), measured under the lease"; else
		echo "FAIL - reap: reported '${reaped_bytes:-}' for a set holding two ~512 KiB blobs" >&2
		fails=$((fails + 1))
	fi
	_gone "node_modules" "reap: the root node_modules is gone"
	_gone "apps/console/node_modules" "reap: the nested workspace node_modules is gone"
	_exists "vendored/node_modules/index.js" "survives: a node_modules git does NOT ignore"
	_exists "tools/node_modules/vendored.js" "survives: a TRACKED file inside an ignored node_modules"
	_exists "keep/scratch.txt" "survives: an untracked file"
	_a "uncommitted" "$(tail -n 1 "$wt/keep/app.ts" 2>/dev/null)" "survives: the uncommitted edit, byte for byte"
	_a "wtdehydrate" "$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo GONE)" "survives: the worktree itself, on its own branch"
	_a "free" "$(CLAUDE_PID="$me" wt_lease_state "$wt")" "reap: the lease is handed straight back, not left reading as ours"
	_a "clean" "$(CLAUDE_PID="$me" wt_dehydrate_verdict "$wt" | cut -f1)" "reap: a second pass reports 'clean' rather than re-reaping"

	# ── THE COMMAND, end to end ────────────────────────────────────────────────────────────────
	#
	# Everything above tests FUNCTIONS. The command is a separate artefact — arg parsing, the
	# verdict→line rendering, the skip/clean/reap dispatch, the running totals, and the byte figure
	# it prints — and none of it was covered: deleting `bytes="$freed"` left the whole suite green
	# while the real command reported `up to 0B` instead of `up to 2.0M`. That figure is what this
	# PR calls the tool's entire justification, so it is now driven rather than asserted about.
	#
	# Its own throwaway repo, for the reason the --who fixture has one.
	local cmd="$tmp/cmdrepo" cout
	mkdir -p "$cmd/main/scripts/lib"
	git init -q "$cmd/main"
	printf 'node_modules\n' >"$cmd/main/.gitignore"
	git -C "$cmd/main" add .gitignore
	git -C "$cmd/main" -c user.email=t@t -c user.name=t commit -q -m init
	cp "$0" "$cmd/main/scripts/worktree.sh"
	cp "$(cd "$(dirname "$0")" && pwd)/lib/"*.sh "$cmd/main/scripts/lib/"
	# Three trees: one reapable (stale lease, hydrated), one held by a LIVE instance, one clean.
	git -C "$cmd/main" worktree add -q -b creap "$cmd/wt-creap"
	git -C "$cmd/main" worktree add -q -b cheld "$cmd/wt-cheld"
	git -C "$cmd/main" worktree add -q -b cclean "$cmd/wt-cclean"
	mkdir -p "$cmd/wt-creap/node_modules" "$cmd/wt-cheld/node_modules"
	dd if=/dev/zero of="$cmd/wt-creap/node_modules/blob" bs=1024 count=2048 2>/dev/null
	: >"$cmd/wt-cheld/node_modules/blob"
	_stamp() { # <worktree> <pid> <procstart>
		local d
		d="$(git -C "$1" rev-parse --absolute-git-dir)/alethia-lease"
		mkdir -p "$d"
		{
			echo "pid: $2"
			echo "procStart: $3"
			echo "host: $(wt_host)"
		} >"$d/owner"
	}
	_stamp "$cmd/wt-creap" 999999 "Thu Jan  1 00:00:00 1970"
	_stamp "$cmd/wt-cheld" 1 "$(wt_procstart 1)"

	cout="$(CLAUDE_PID="$me" bash "$cmd/main/scripts/worktree.sh" --dehydrate --dry-run 2>&1)"
	_has() { if printf '%s' "$2" | grep -qF -- "$1"; then echo "ok   - $3"; else
		echo "FAIL - $3: not in output. Got:" >&2
		printf '%s\n' "$2" >&2
		fails=$((fails + 1))
	fi; }
	_has "WOULD reap" "$cout" "cmd: --dry-run names the tree it would reap"
	_has "up to 2.0M on disk" "$cout" "cmd: --dry-run reports the CEILING it measured, not 0B"
	_has "held by another LIVE instance" "$cout" "cmd: --dry-run skips the live-held tree"
	# The VERB as well as the reason: asserting only "already de-hydrated" let a mutant that
	# rendered the clean tree as a `skip` survive, because the reason text is identical either way.
	# Matched by PATTERN, not by embedding $cmd: `git worktree list` reports PHYSICAL paths, and on
	# macOS mktemp hands back /var/... while git prints /private/var/... — the same symlink trap
	# wt-lease.sh's wt_abs() exists for.
	_hasre() { if printf '%s' "$2" | grep -qE -- "$1"; then echo "ok   - $3"; else
		echo "FAIL - $3: no line matching /$1/. Got:" >&2
		printf '%s\n' "$2" >&2
		fails=$((fails + 1))
	fi; }
	_hasre '^  ok    .*/wt-cclean  \(cclean\)' "$cout" "cmd: the clean tree renders as 'ok', not as a skip"
	_has "already de-hydrated" "$cout" "cmd: … and says why"

	_has "1 held by a live instance, 1 not a target" "$cout" "cmd: --dry-run counts HELD apart from not-a-target"
	_a "yes" "$([ -e "$cmd/wt-creap/node_modules/blob" ] && echo yes || echo no)" "cmd: --dry-run deleted nothing"

	# ── an unknown argument must REFUSE, not fall through to the destructive run ────────────────
	# `--dry-runn` and `-n` both used to perform the real reap, because the parse only ever SET the
	# flag and never rejected anything. A typo in the safety flag doing the dangerous thing is the
	# worst available default, so the exit code, the message AND the tree are all asserted.
	# `bout`, not `cout`: reusing the outer variable clobbered the dry run's output and made a
	# LATER assertion fail naming something it had nothing to do with.
	local bout brc
	for badflag in --dry-runn -n --force; do
		brc=0
		bout="$(CLAUDE_PID="$me" bash "$cmd/main/scripts/worktree.sh" --dehydrate "$badflag" 2>&1)" || brc=$?
		if [ "$brc" -ne 0 ] && printf '%s' "$bout" | grep -q "unknown argument"; then
			echo "ok   - cmd: '$badflag' is refused, not ignored (exit $brc)"
		else
			echo "FAIL - cmd: '$badflag' was accepted (exit $brc) — a mistyped safety flag ran the real reap" >&2
			fails=$((fails + 1))
		fi
	done
	_a "yes" "$([ -e "$cmd/wt-creap/node_modules/blob" ] && echo yes || echo no)" "cmd: … and nothing was deleted while refusing"

	cout="$(CLAUDE_PID="$me" bash "$cmd/main/scripts/worktree.sh" --dehydrate 2>&1)"
	_has "freed up to 2.0M on disk" "$cout" "cmd: the real run reports the bytes IT removed"
	_has "reaped 1 tree(s), up to 2.0M on disk" "$cout" "cmd: the total is the sum of what was reaped"
	_has "1 held by a live instance, 1 not a target" "$cout" "cmd: the real run counts HELD apart too"
	_a "no" "$([ -e "$cmd/wt-creap/node_modules/blob" ] && echo yes || echo no)" "cmd: the reapable tree WAS reaped"
	_a "yes" "$([ -e "$cmd/wt-cheld/node_modules/blob" ] && echo yes || echo no)" "cmd: the live-held tree was NOT"
	_a "free" "$(CLAUDE_PID="$me" wt_lease_state "$cmd/wt-creap")" "cmd: the reaped tree's stale lease record went with it"
	rm -rf "$cmd"

	git -C "$tmp/main" worktree remove --force "$wt" 2>/dev/null || true
	if [ "$fails" -eq 0 ]; then echo "worktree dehydrate self-test: all passed"; else
		echo "worktree dehydrate self-test: $fails check(s) FAILED" >&2
	fi
	return "$fails"
}

if [ "${1:-}" = "--self-test" ]; then
	# Called BARE, deliberately. bash suppresses `set -e` for the entire body of a function invoked
	# as an operand of `&&`/`||` or as an `if` condition, so the obvious `wt_dehydrate_self_test ||
	# rc=$?` would run the whole suite with -e DISABLED — a suite that cannot observe an abort
	# production would suffer. Called bare, an abort anywhere in the suite ends the process
	# non-zero, and `set -e` propagates a non-zero `return "$fails"` for us, so the exit code still
	# reports the result either way. The exit code is the test; the printed lines are the report.
	wt_dehydrate_self_test
	exit 0
fi

# `pnpm wt:rm <name>` routes here as: worktree.sh --remove <name>
if [ "${1:-}" = "--remove" ]; then
	name="${2:-}"
	[ -n "$name" ] || usage
	name="${name#feat/}"
	dir="../wt-${name}"
	# Removing another live instance's worktree destroys their work outright — strictly worse than
	# the reuse path that caused #1247, and previously completely unguarded.
	require_free "$dir" "remove"
	if git worktree remove "$dir" 2>/dev/null; then
		echo "✓ removed $dir"
	else
		echo "✗ couldn't remove $dir — it may have uncommitted changes." >&2
		echo "  Inspect it, or force: git worktree remove --force $dir" >&2
		exit 1
	fi
	exit 0
fi

name="${1:-}"
[ -n "$name" ] || usage
name="${name#feat/}" # tolerate `pnpm wt feat/foo`
branch="feat/${name}"
dir="../wt-${name}"
install=0
[ "${2:-}" = "--install" ] && install=1

if [ -d "$dir" ]; then
	require_free "$dir" "reuse"
	echo "↳ $dir already exists (branch $(git -C "$dir" rev-parse --abbrev-ref HEAD)) — leased to you (pid $(wt_self_pid))."
else
	git fetch -q origin dev 2>/dev/null || true
	base="origin/dev"
	git rev-parse --verify -q "$base" >/dev/null 2>&1 || base="dev"

	# ── WHERE THE BRANCH STARTS, decided rather than defaulted ────────────────────────────────────
	#
	# This used to be "if the branch exists anywhere, check it out; else branch off $base" — and it
	# printed "(off $base)" in BOTH cases. The second half of that sentence was a lie in the first
	# case, and it is the dangerous kind: a `feat/<name>` left on the REMOTE by a MERGED PR is a
	# perfectly ordinary thing for this repo to have (Mergify does not delete branches, and 13 such
	# branches exist today), so `pnpm wt <name>` for a name used once before silently started the new
	# work on the old, landed tip.
	#
	# MEASURED, on this repo, while fixing #2843: `pnpm wt hetzner-zone-depth` reported
	# "created ../wt-hetzner-zone-depth on feat/hetzner-zone-depth (off origin/dev)" and put the
	# worktree 125 COMMITS BEHIND dev, on the branch of merged PR #2844. The reflog says it plainly:
	# `branch: Created from refs/remotes/origin/feat/hetzner-zone-depth`. Two files edited in that
	# tree would have been REVERTED by the resulting PR, and the diff would have read as deliberate.
	# It was caught only because a script the work needed was missing from the tree.
	#
	# `--is-ancestor` cannot see this: every dev PR lands as a SQUASH, so a landed branch is never an
	# ancestor of dev — 0 of the 13 remote feat/* branches pass that test. wt_branch_landed() asks the
	# question properly and already exists, for `wt:prune`. The create path simply never asked it, so
	# the same fact was known in one place and guessed in another.
	start="$base"
	start_why="off $base"
	if git show-ref --verify -q "refs/heads/$branch"; then
		# A LOCAL branch is yours and is almost always a resume. Reused, but never silently: the
		# staleness line below is what makes "resume" distinguishable from "start".
		start="$branch"
		start_why="resuming your existing local branch"
	elif git show-ref --verify -q "refs/remotes/origin/$branch"; then
		if wt_branch_landed "$(git rev-parse --show-toplevel)" "origin/$branch" "$base"; then
			# Landed work is ALREADY in $base. Starting from it can only rewind the tree, so this is
			# not a question worth asking anybody — it is corrected, and said out loud.
			echo "⚠ origin/$branch exists but has already LANDED ($WT_LANDED_WHY)."
			echo "  Starting from $base instead — its work is in there, and branching off the old tip"
			echo "  would silently rewind every file this worktree touches."
		else
			# Unlanded remote work is somebody's live branch. Continue it, and name what it is.
			start="origin/$branch"
			start_why="continuing origin/$branch, which has NOT landed ($WT_LANDED_WHY)"
		fi
	fi

	if [ "$start" = "$branch" ]; then
		git worktree add "$dir" "$branch"
	else
		git worktree add "$dir" -b "$branch" "$start"
	fi
	echo "✓ created $dir on $branch ($start_why)"

	# ALWAYS report the distance, on every path. The failure above was invisible because nothing
	# printed a number — and a number is the only thing that distinguishes "off origin/dev" from
	# "off something that was origin/dev in July".
	behind="$(git -C "$dir" rev-list --count "HEAD..$base" 2>/dev/null || echo "?")"
	if [ "$behind" = "0" ]; then
		echo "  at $(git -C "$dir" rev-parse --short HEAD) — level with $base"
	else
		echo "⚠ at $(git -C "$dir" rev-parse --short HEAD) — $behind commit(s) BEHIND $base."
		echo "  Bring it forward before you build on it, from inside $dir."
	fi
	# Own it from birth, before anything can be written into it.
	wt_lease_acquire "$dir" >/dev/null || true
fi

# No port is suggested any more, and no install is implied: a worktree is SOURCE ONLY.
# It runs on the sandbox box (pnpm env:up), which allocates its own port from the
# registry there. Installing node_modules into every worktree is what filled the disk —
# 8 hydrated trees measured ~24 GB — and a locally-suggested port is now a dead end,
# because guard-runtime.sh blocks the local dev server anyway.
abs="$(cd "$dir" && pwd)"
echo ""
echo "Next:"
echo "  cd $abs"
if [ "$install" = 1 ]; then
	echo "  --install: installing locally (only needed for editor/vitest in the MAIN checkout)"
	(cd "$dir" && pnpm install)
else
	echo "  pnpm env:up              # run it on the box — prints the URL"
	echo "  pnpm env:check           # tsc + lint + vitest, also on the box"
fi
echo ""
echo "Commit here (not in app/); push; open a PR into dev."
