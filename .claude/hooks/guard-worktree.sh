#!/usr/bin/env bash
# PreToolUse(Bash) guard: keep parallel Claude instances out of the shared main checkout.
# Blocks `git commit` and `git add -A|--all|.` when the commit would land in the main `app/`
# checkout — redirect to a worktree (`pnpm wt <name>`). This is the early, friendly counterpart to
# the committed .githooks/pre-commit (which also covers humans + CLI).
#
# Exit 2 = block the tool call and surface stderr to the model. Exit 0 = allow.
# Mirrors .claude/hooks/guard-compose.sh.
input="$(cat)"

# Only care about `git commit` or `git add -A|--all|.` — bail fast on anything else.
if ! printf '%s' "$input" | grep -Eq 'git[[:space:]]+commit([[:space:]]|"|\\|$)|git[[:space:]]+add[[:space:]]+(-A|--all|\.)([[:space:]]|"|\\|$)'; then
	exit 0
fi

# Deliberate override (matches the git hook's escape).
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
	# Linked worktree ⇔ git-dir != git-common-dir. Confirmed by git → allow.
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
	echo "BLOCKED: this commit would land in the shared main checkout ($dir). Don't \`git commit\` or \`git add -A\` here — parallel sessions share this tree and it tangles their WIP (this is how the ba0c664 mega-commit happened). Work in your own worktree: \`pnpm wt <name>\` → ../wt-<name>, and commit there (\`cd ../wt-<name> && git commit …\`). Deliberate main commit: prefix ALETHIA_ALLOW_MAIN_COMMIT=1, or git commit --no-verify." >&2
	exit 2
fi
exit 0
