#!/usr/bin/env bash
# PreToolUse guard: keep parallel Claude instances out of each other's trees.
#
# Two rules, in order:
#   R-LEASE  don't write inside a worktree another LIVE instance is working in.
#   R-MAIN   don't `git commit` / `git add -A` in the shared main checkout  (the original rule).
#
# R-LEASE exists because R-MAIN wasn't enough. On 2026-07-26 a second instance ran
# `pnpm wt <name>`, was handed the first's live worktree ("already exists … Reusing it"), edited
# files in it, and committed the first instance's UNCOMMITTED work under its own message. Every
# step passed this hook, because the only question it asked was "is this A worktree?" — never "is
# it MINE?" — and because the hook was wired for Bash alone, so the Write/Edit calls that did most
# of the damage were never seen at all.
#
# Wired for Bash AND Write|Edit|MultiEdit|NotebookEdit|EnterWorktree (see .claude/settings.json).
# Exit 2 = block the tool call and surface stderr to the model. Exit 0 = allow.
# Mirrors .claude/hooks/guard-compose.sh.
input="$(cat)"

# Resolve the helper relative to THIS FILE, not to CLAUDE_PROJECT_DIR: the project dir may point at
# a worktree, or at a different repo entirely, and silently falling through to the fail-open stub
# would disable the guard with no signal (it did exactly that the first time this was tested).
lib="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)/scripts/lib/wt-lease.sh"
[ -f "$lib" ] || lib="${CLAUDE_PROJECT_DIR:-$PWD}/scripts/lib/wt-lease.sh"
# Fail OPEN if the helper is missing (a branch cut before this landed, a partial checkout). A guard
# that breaks every tool call when a file is absent is worse than the hole it closes.
if [ -f "$lib" ]; then
	# shellcheck source=/dev/null
	. "$lib"
else
	wt_lease_acquire() { return 2; }
	wt_root_of() { printf ''; }
	wt_abs() { printf '%s' "$1"; }
fi

# ── payload fields, without a jq dependency ─────────────────────────────────────────────────────
# Probe for KEYS rather than dispatching on tool_name: a Bash payload has no file_path, an Edit
# payload has no command. That removes a whole class of "did the harness rename the tool" bug.
#
# jq when available (exact). Otherwise a grep that emits EVERY match and the caller unions them:
# block if ANY candidate is foreign. The asymmetry is deliberate — a decoy `"file_path": "…"`
# inside an Edit's new_string can cause a spurious BLOCK (recoverable, and there's an escape
# hatch), but can never cause a spurious ALLOW.
payload_field() { # <key>
	if command -v jq >/dev/null 2>&1; then
		printf '%s' "$input" | jq -r --arg k "$1" '.tool_input[$k] // empty' 2>/dev/null && return 0
	fi
	printf '%s' "$input" |
		grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"([^\"\\\\]|\\\\.)*\"" |
		sed -E "s/^\"$1\"[[:space:]]*:[[:space:]]*\"//; s/\"\$//" |
		sed -e 's/\\"/"/g' -e 's/\\\\/\\/g'
}

payload_cwd() {
	if command -v jq >/dev/null 2>&1; then
		printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null && return 0
	fi
	printf '%s' "$input" | grep -oE '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' | tail -1 |
		sed -E 's/^"cwd"[[:space:]]*:[[:space:]]*"//; s/"$//'
}

# ── the deny message ────────────────────────────────────────────────────────────────────────────
deny() { # <worktree-root> <what>
	local ld idle
	ld="$(wt_lease_dir "$1" 2>/dev/null)"
	idle="$(wt_lease_idle "$ld" 2>/dev/null || echo unknown)"
	{
		echo "BLOCKED: $1 is checked out by ANOTHER LIVE Claude instance — $2 there is not allowed."
		echo "  holder   pid ${WT_L_PID:-?} (started ${WT_L_PS:-?}) on ${WT_L_HOST:-?}"
		echo "  session  ${WT_L_SESSION:-?} · branch ${WT_L_BRANCH:-?}"
		echo "  leased   $(wt_lease_age 2>/dev/null || echo '?') ago · last active $idle"
		echo ""
		echo "Writing here commits their uncommitted work under your message — that is exactly what"
		echo "happened on issue #1247. Work in your OWN worktree:  pnpm wt <name>  →  ../wt-<name>."
		echo "  who holds what:       pnpm wt:who"
		echo "  they are really gone: pnpm wt:steal <name>"
		echo "  deliberate override:  ALETHIA_ALLOW_FOREIGN_WT=1 (maintainer only — instances must not)"
	} >&2
	exit 2
}

# ── R-LEASE, path-based tools (Write / Edit / MultiEdit / NotebookEdit / EnterWorktree) ─────────
# No parsing risk here: the path is a structured field. This branch is also what makes the retrofit
# work — every existing worktree is currently unleased, so ownership is taken on first write.
for key in file_path notebook_path path; do
	while IFS= read -r p; do
		[ -n "$p" ] || continue
		root="$(wt_root_of "$(wt_abs "$p")")"
		[ -n "$root" ] || continue
		wt_lease_acquire "$root"
		[ "$?" = 1 ] && deny "$root" "editing files"
	done <<EOF
$(payload_field "$key")
EOF
done

# ── R-LEASE, Bash ───────────────────────────────────────────────────────────────────────────────
cmd="$(payload_field command)"

# Does this ONE segment reference <root>? Re-runs the same path extraction the target loop uses, so
# a segment can never be judged by a different notion of "which paths does this touch".
seg_touches_root() { # <segment> <base> <root>
	local seg="$1" base="$2" root="$3" tok
	while IFS= read -r tok; do
		[ -n "$tok" ] || continue
		[ "$(wt_root_of "$(wt_abs "$tok" "$base")")" = "$root" ] && return 0
	done <<EOF
$(
		printf '%s' "$seg" | grep -oE '(^|[^[:alnum:]_-])git[[:space:]]+-[Cc][[:space:]]+[^[:space:];&|]+' | sed -E 's/.*-[Cc][[:space:]]+//'
		printf '%s' "$seg" | tr '[:space:]=' '\n' | grep -E '/' | grep -vE '^-'
	)
EOF
	return 1
}

# Read-only ⇔ every segment that TOUCHES the foreign worktree is a git READ. Deliberately git-only:
# the set of git read subcommands is small, well-known and stable, whereas a general read allowlist
# (cat/grep/find/…) drifts with tooling and every gap in it is a false block anyway. So any NON-git
# command aimed at a foreign live worktree is treated as write-ish.
#
# SCOPE (<root>): when the foreign tree was reached by an explicit path, a segment that never
# mentions it cannot harm it — so `git -C ../wt-x log | head -3` is a read, and only `head` being
# absent from a git allowlist used to block it. Piping a git read to a pager is routine, and a guard
# that cries wolf is one people learn to override. Pass an EMPTY root for residency (payload cwd or
# a `cd` into the tree): there the whole command runs INSIDE the worktree, so every segment counts,
# and `cd ../wt-x && rm -rf .` must still be refused even though it names no path.
#
# Consulted ONLY after a target is known to be a foreign live worktree, where a non-read command
# has no legitimate purpose — so it is deny-by-default and every misclassification is a recoverable
# false block, never a false allow.
cmd_is_git_read() { # <command> <base> <scope-root|"">
	local seg had=0
	while IFS= read -r seg; do
		seg="$(printf '%s' "$seg" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
		[ -z "$seg" ] && continue
		# Scoped: a segment that doesn't touch the foreign tree is a neutral formatting sink.
		if [ -n "$3" ] && ! seg_touches_root "$seg" "$2" "$3"; then continue; fi
		had=1
		printf '%s' "$seg" | grep -qE '(\$\(|`|(^|[^0-9<>&])>|<\()' && return 1 # subst / redirect
		printf '%s' "$seg" | grep -qE '^git([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+)*[[:space:]]+(status|log|show|diff|difftool|blame|annotate|shortlog|describe|rev-parse|rev-list|cat-file|ls-files|ls-tree|ls-remote|for-each-ref|show-ref|symbolic-ref|name-rev|merge-base|grep|count-objects|whatchanged|version)([[:space:]]|$)' && continue
		printf '%s' "$seg" | grep -qE '^git([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+)*[[:space:]]+(worktree[[:space:]]+list|stash[[:space:]]+(list|show)|reflog([[:space:]]+show)?|remote([[:space:]]+(-v|show))?|config[[:space:]]+--get|branch[[:space:]]+(-v|-vv|-a|-r|--list|--contains)|tag[[:space:]]+(-l|--list))([[:space:]]|$)' && continue
		return 1
	done <<EOF
$(printf '%s' "$1" | tr ';|&' '\n\n\n')
EOF
	[ "$had" = 1 ]
}

if [ -n "$cmd" ]; then
	base="$(payload_cwd)"
	[ -n "$base" ] || base="${CLAUDE_PROJECT_DIR:-$PWD}"

	# Candidate target dirs: the session cwd (residency) ∪ every `git -C <p>` ∪ every `cd <p>` ∪
	# every bare token containing `/`. That last one is what the old hook lacked entirely, and it
	# is what catches `sed -i ../wt-x/f`, `cp a ../wt-x/b`, `rm -rf ../wt-x`.
	scan="$(printf '%s' "$cmd" | tr -d '\42\47\134')" # drop  "  '  \  — repo paths have none

	# Targets are tagged by PROVENANCE, because it changes how strictly the command is judged:
	#   R = residency — the session cwd, or a `cd` into the tree. The whole command runs INSIDE it.
	#   P = an explicit path — `git -C <p>`, or a bare token. Only the segments naming it can touch it.
	targets="$(
		printf 'R\t%s\n' "$base"
		printf '%s' "$scan" | grep -oE '(^|[^[:alnum:]_])cd[[:space:]]+[^[:space:];&|]+' | sed -E 's/.*cd[[:space:]]+/R\t/'
		printf '%s' "$scan" | grep -oE '(^|[^[:alnum:]_-])git[[:space:]]+-[Cc][[:space:]]+[^[:space:];&|]+' | sed -E 's/.*-[Cc][[:space:]]+/P\t/'
		printf '%s' "$scan" | tr '[:space:];&|=' '\n' | grep -E '/' | grep -vE '^-' | sed -E 's/^/P\t/'
	)"

	while IFS= read -r line; do
		[ -n "$line" ] || continue
		kind="${line%%	*}"
		t="${line#*	}"
		[ -n "$t" ] || continue
		root="$(wt_root_of "$(wt_abs "$t" "$base")")"
		[ -n "$root" ] || continue
		wt_lease_acquire "$root"
		if [ "$?" = 1 ]; then
			# Residency judges the whole command; an explicit path judges only the segments naming it.
			if [ "$kind" = "R" ]; then
				cmd_is_git_read "$cmd" "$base" "" && continue
			else
				cmd_is_git_read "$cmd" "$base" "$root" && continue
			fi
			deny "$root" "running commands"
		fi
	done <<EOF
$targets
EOF
fi

# ── R-MAIN: the original main-checkout rule ─────────────────────────────────────────────────────
# Only care about a commit / stage-everything invocation — bail fast on anything else.
#
# Scan the COMMAND FIELD, not the raw payload. Scanning the whole JSON meant any
# Write/Edit whose CONTENT merely mentioned the blocked phrases was rejected as if it
# were a commit — this guard blocked an edit to its own message text, and it blocks
# documenting the rule anywhere in the repo. A Bash payload is the only one with a
# `command` key, so this also scopes R-MAIN to Bash without dispatching on tool_name
# (the same key-probing rationale as payload_field above).
cmd_text="$(payload_field command)"
[ -n "$cmd_text" ] || exit 0
if ! printf '%s' "$cmd_text" | grep -Eq 'git[[:space:]]+commit([[:space:]]|"|\\|$)|git[[:space:]]+add[[:space:]]+(-A|--all|\.)([[:space:]]|"|\\|$)'; then
	exit 0
fi

# Deliberate override. It must be EXPORTED BEFORE `claude` starts. This is a PreToolUse
# hook, spawned before the Bash tool runs, so an inline `VAR=1 …` prefix inside the
# command text is never in THIS process's environment. The same prefix DOES work for
# .githooks/pre-commit, which git spawns as its own child — the two layers genuinely
# need different advice, which is why the block message below spells both out.
[ "${ALETHIA_ALLOW_MAIN_COMMIT:-}" = "1" ] && exit 0

# --- Where will this commit ACTUALLY run? ---------------------------------------------------------
# This PreToolUse hook runs BEFORE the command, in the session's launch dir, so $CLAUDE_PROJECT_DIR
# and $PWD both point at the MAIN checkout even when the session (via EnterWorktree) or an explicit
# `cd` targets a worktree — which is why a legitimate worktree commit used to be blocked here.
# git's behaviour is fully determined by the command text, so read the effective dir from it:
#   * `git -C <path> (commit|add)` wins — it's authoritative for that invocation, else
#   * the LAST `cd <path>` before the commit/add keyword (git's cwd in a normal && / ; chain).
# Then let git ITSELF confirm the dir is a linked worktree. We allow ONLY on that positive
# confirmation; anything unparsed / unresolved / main-checkout falls through to the block below.
# Repo paths never contain spaces or quotes, so stripping quotes and taking a bare token is safe.
scan="$(printf '%s' "$input" | tr -d '\42\47\134')" # drop  "  '  \  (incl. JSON escaping)

target="$(printf '%s' "$scan" |
	grep -oE 'git[[:space:]]+-C[[:space:]]+[^[:space:];&|]+[[:space:]]+(commit|add)' |
	tail -1 | sed -E 's/^git[[:space:]]+-C[[:space:]]+//; s/[[:space:]]+(commit|add)$//')"

if [ -z "$target" ]; then
	# The part of the command up to the commit/add keyword — the effective cwd lives here.
	prefix="${scan%%git commit*}"
	[ "$prefix" = "$scan" ] && prefix="${scan%%git add*}"
	# `cd` as its own word: preceded by start-of-string or any non-word char (a shell delimiter
	# like ; & <space>, or the surrounding JSON punctuation `:`/`{`/`,` left after quote-stripping) —
	# NOT the "cd" inside a word like "abcd". tail -1 = the last cd before the commit (git's cwd).
	target="$(printf '%s' "$prefix" |
		grep -oE '(^|[^a-zA-Z0-9_])cd[[:space:]]+[^[:space:];&|]+' |
		tail -1 | sed -E 's/.*cd[[:space:]]+//')"
fi

if [ -n "$target" ]; then
	tgd="$(git -C "$target" rev-parse --git-dir 2>/dev/null || true)"
	tgcd="$(git -C "$target" rev-parse --git-common-dir 2>/dev/null || true)"
	# Linked worktree ⇔ git-dir != git-common-dir. Confirmed by git → allow. (R-LEASE above has
	# already established the worktree isn't someone else's.)
	if [ -n "$tgd" ] && [ "$tgd" != "$tgcd" ]; then
		exit 0
	fi
fi

# --- Fall-through: no confirmed worktree ⇒ the original main-checkout guard, unchanged -------------
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
gd="$(git -C "$dir" rev-parse --git-dir 2>/dev/null || echo _gd)"
gcd="$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null || echo _gcd)"

# Main checkout ⇔ git-dir == git-common-dir. Linked worktrees differ, so they pass.
if [ "$gd" = "$gcd" ]; then
	echo "BLOCKED: this would commit into the shared main checkout ($dir). Parallel sessions share this tree and it tangles their WIP (this is how the ba0c664 mega-commit happened). Work in your own worktree: \`pnpm wt <name>\` → ../wt-<name>, then commit from there — a \`git -C ../wt-<name> …\` invocation is parsed by this guard and allowed. Deliberate main commit: export ALETHIA_ALLOW_MAIN_COMMIT=1 BEFORE launching claude — an inline VAR=1 prefix cannot work here, because this hook is spawned before the command runs; and --no-verify skips only the git hook, not this one." >&2
	exit 2
fi
exit 0
