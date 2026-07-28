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
#   pnpm wt:release [name]    hand your worktree back
#   pnpm wt:steal <name>      take a worktree whose holder is really gone
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

usage() {
	echo "Usage: pnpm wt <name> [--install] | pnpm wt:ls | pnpm wt:who | pnpm wt:rm <name> | pnpm wt:release [name] | pnpm wt:steal <name>" >&2
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

# `pnpm wt:who` — the discoverability answer. Nothing used to tell you a worktree was taken until
# you had already trampled it.
if [ "${1:-}" = "--who" ]; then
	printf '%-46s %-34s %s\n' WORKTREE BRANCH HOLDER
	git worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r w; do
		[ -n "$w" ] || continue
		br="$(git -C "$w" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
		ld="$(wt_lease_dir "$w" 2>/dev/null || true)"
		if [ -z "$ld" ]; then
			who="— (main checkout, shared)"
		elif ! wt_lease_read "$ld" 2>/dev/null; then
			who="free"
		elif wt_lease_live; then
			mine=""
			wt_lease_is_mine && mine=" ← you"
			who="LIVE pid $WT_L_PID on $WT_L_HOST · idle $(wt_lease_idle "$ld")$mine"
		else
			who="stale (holder gone) — reclaimed on next use"
		fi
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

# `pnpm wt:prune` — remove worktrees whose branch is already merged into dev.
#
# Only ever touches trees that are (a) free (no live lease), (b) clean (no uncommitted
# or untracked files), and (c) on a branch already contained in origin/dev. Anything
# failing any test is REPORTED AND SKIPPED, never forced: on 2026-07-27 a sweep found a
# tree with 22 untracked .tf files that a bad scan had cleared for deletion, and the
# only thing that saved it was `git worktree remove` refusing without --force.
if [ "${1:-}" = "--prune" ]; then
	git fetch -q origin dev 2>/dev/null || true
	base="origin/dev"
	git rev-parse --verify -q "$base" >/dev/null 2>&1 || base="dev"
	removed=0
	kept=0
	while IFS= read -r wt; do
		[ -n "$wt" ] || continue
		case "$wt" in */wt-*) ;; *) continue ;; esac
		br="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"

		if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
			echo "  skip  $wt  ($br) — uncommitted or untracked work"
			kept=$((kept + 1))
			continue
		fi
		if ! git merge-base --is-ancestor "$br" "$base" 2>/dev/null; then
			echo "  skip  $wt  ($br) — not merged into ${base}"
			kept=$((kept + 1))
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
$(git worktree list --porcelain | awk '/^worktree /{print $2}')
EOF
	git worktree prune
	echo ""
	echo "✓ removed $removed, kept $kept. Nothing was forced."
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
	if git show-ref --verify -q "refs/heads/$branch" ||
		git show-ref --verify -q "refs/remotes/origin/$branch"; then
		git worktree add "$dir" "$branch"
	else
		git worktree add "$dir" -b "$branch" "$base"
	fi
	echo "✓ created $dir on $branch (off $base)"
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
