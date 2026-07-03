#!/usr/bin/env bash
# PreToolUse(Bash) guard: the `alethia` compose stack is shared across every Claude
# window (docker-compose.yml hardcodes `name: alethia`). Block a raw `docker compose up`
# and redirect to the lock-guarded wrapper, so two windows can't race a build.
#
# Intentionally does NOT match:
#   - `pnpm compose:up` (the wrapper; its inner `docker compose up` is a subprocess
#     the hook never sees), nor
#   - `docker compose ps|logs|down|build` (safe / non-racing).
#
# Exit 2 = block the tool call and surface stderr to the model. Exit 0 = allow.
input="$(cat)"

# Match the command anywhere in the raw hook JSON — macOS-safe, no jq/python needed.
# `docker( |-)compose` … then `up` as a word, allowing any flags/args in between
# (e.g. `-f file`, `-p name`). `[^&;|"]*` keeps the match inside one command string
# (stops at a separator or the JSON closing quote) to avoid bleeding across fields.
if printf '%s' "$input" | grep -Eq 'docker(-|[[:space:]]+)compose\b[^&;|"]*[[:space:]]up\b'; then
  echo "BLOCKED: don't run \`docker compose up\` directly — the alethia stack is shared across every Claude window. Use \`pnpm compose:up\` (lock-guarded; see CLAUDE.md → Local stack). For status use \`pnpm compose:ps\` / \`pnpm compose:logs\`." >&2
  exit 2
fi
exit 0
