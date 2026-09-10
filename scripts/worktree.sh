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
wt_dehydrate_verdict() { # <worktree> → verb<TAB>bytes<TAB>why
	local wt="$1" state dirs bytes=0 n=0 d
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
			# wt_lease_dir() reports "not leasable" for the shared main checkout AND for a tree
			# whose .git git can no longer read — and a broken .git is exactly what an abandoned
			# worktree has. Same safe action, but one sentence would be false. The residual of the
			# gone-directory case above: a true mechanism under a false label.
			if git -C "$wt" rev-parse --absolute-git-dir >/dev/null 2>&1; then
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
		bytes=$((bytes + $(wt_dir_bytes "$d")))
		n=$((n + 1))
	done <<NMEOF
$dirs
NMEOF
	printf 'reap\t%s\tup to %s on disk across %s node_modules dir(s), lease %s\n' "$bytes" "$(wt_human_bytes "$bytes")" "$n" "$state"
}

# Remove <worktree>'s reapable node_modules and NOTHING else.
#   0 = reaped
#   1 = REFUSED, and nothing was touched — a live instance holds it
#
# The verdict was read WITHOUT taking ownership, so the window between the scan and the `rm` is real
# — a find, a `du -sk` over up to 2 GB, then a second find. Something has to re-ask the question
# here, and it takes TWO calls, because neither one alone answers it:
#
#   · wt_lease_acquire  TAKES the tree, so the reap owns what it deletes and a racing instance is
#     blocked for the duration. But it is agent-scoped by design: it returns 0 WITHOUT LOOKING AT
#     THE LEASE when there is no agent marker (wt-lease.sh: "Humans and CI are not gated by this
#     file") and again under ALETHIA_ALLOW_FOREIGN_WT=1. `|| return 1` reads both of those as "I own
#     it, delete".
#   · wt_lease_state    READS the lease and honours NEITHER hatch, so it is the only one of the two
#     that can still say "live" for a human at a terminal — which is exactly who runs this command
#     at 94% disk. It cannot take the tree, so it cannot replace the acquire either.
#
# MEASURED before the second line existed, with a live holder and the tree already scanned: an agent
# was refused (rc 1, node_modules intact); a HUMAN and an agent under the hatch both deleted it.
# So: acquire for ownership, then re-read for the answer, and refuse on either.
#
# (require_free() is the acquire with an exit() on top, which is wrong for a sweep — one held tree
# must not end the run. --prune calls wt_lease_acquire directly for exactly that reason.)
#
# HONEST SCOPE: the self-test kills the loss of the STATE re-read, but NOT the loss of the acquire —
# the state check alone already refuses every live tree a single-process fixture can build. What the
# acquire adds is mutual exclusion for the DURATION of the rm, against an instance arriving after
# the check, and observing that needs two processes racing, not a fixture. Removing it would leave
# the suite green. It stays because the window it closes is the one the whole function is about.
# Would `wt:dehydrate` actually reach this tree? Used ONLY by --prune's hint line, which must not
# promise a command that will refuse: counting a live-held hydrated tree there tells the reader to
# run something that reaches neither it nor, possibly, anything at all.
wt_count_reachable_hydrated() { # <worktree> → 0 if wt:dehydrate would reap it
	[ "$(wt_dehydrate_verdict "$1" | cut -f1)" = reap ]
}

wt_dehydrate_tree() { # <worktree> → prints the bytes it removed, on stdout
	local wt="$1" d dirs bytes=0
	wt_lease_acquire "$wt" >/dev/null 2>&1 || return 1
	# NOT redundant with the line above. See the two bullets: this is the half that survives a
	# missing agent marker and the escape hatch, and refusing here leaves the holder's lease alone.
	case "$(wt_lease_state "$wt")" in live) return 1 ;; esac
	# Derive the set ONCE, under the lease, and measure THE SET WE ARE ABOUT TO DELETE. Reporting
	# the verdict's figure instead was measurably wrong: that one is taken before the acquire, and
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
	# Hand it straight back. The tree SURVIVES a reap, so a lease left behind would make an
	# abandoned worktree read as LIVE-held by a process that has since exited — un-reapable for
	# everyone after, which is the exact wedge this command was written to clear.
	wt_lease_release "$wt" >/dev/null 2>&1 || true
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
			main) who="— (main checkout, shared)" ;;
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
	for a in "$@"; do [ "$a" = "--dry-run" ] && dry=1; done
	total=0
	reaped=0
	kept=0
	# No `*/wt-*` name filter, unlike --prune: the main checkout is excluded because wt_lease_dir
	# says it is not leasable, which is the actual question. The harness also creates worktrees at
	# app/.claude/worktrees/<name>, and those are just as reapable as a sibling wt-*.
	while IFS= read -r wt; do
		[ -n "$wt" ] || continue
		br="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
		verdict="$(wt_dehydrate_verdict "$wt")"
		verb="${verdict%%$'\t'*}"
		rest="${verdict#*$'\t'}"
		bytes="${rest%%$'\t'*}"
		why="${rest#*$'\t'}"
		case "$verb" in
			skip)
				echo "  skip  $wt  ($br) — $why"
				kept=$((kept + 1))
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
			kept=$((kept + 1))
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
		echo "✓ dry run: would reap $reaped tree(s), up to $(wt_human_bytes "$total") on disk, skipping $kept held one(s). Nothing was touched."
		echo "  \"up to\" is the ceiling, not the estimate: pnpm uses APFS clones, so most of these"
		echo "  blocks are shared with the pnpm store and expect FAR less back — 38x less, measured."
	else
		echo "✓ reaped $reaped tree(s), up to $(wt_human_bytes "$total") on disk, skipped $kept held one(s)."
		echo "  No worktree, tracked file or uncommitted change was removed."
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
