#!/usr/bin/env bash
# PreToolUse(Bash) guard: keep parallel Claude instances out of the shared main checkout.
# Blocks `git commit` and `git add -A|--all|.` when THIS instance was launched in the main
# `app/` checkout — redirect to a worktree (`pnpm wt <name>`). This is the early, friendly
# counterpart to the committed .githooks/pre-commit (which also covers humans + CLI).
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

dir="${CLAUDE_PROJECT_DIR:-$PWD}"
gd="$(git -C "$dir" rev-parse --git-dir 2>/dev/null || echo _gd)"
gcd="$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null || echo _gcd)"

# Main checkout ⇔ git-dir == git-common-dir. Linked worktrees differ, so they pass.
if [ "$gd" = "$gcd" ]; then
	echo "BLOCKED: this instance is in the shared main checkout ($dir). Don't \`git commit\` or \`git add -A\` here — parallel sessions share this tree and it tangles their WIP (this is how the ba0c664 mega-commit happened). Create your own worktree: \`pnpm wt <name>\` → ../wt-<name>, cd there, and work. Deliberate main commit: prefix ALETHIA_ALLOW_MAIN_COMMIT=1, or git commit --no-verify." >&2
	exit 2
fi
exit 0
