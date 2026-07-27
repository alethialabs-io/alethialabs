#!/usr/bin/env bash
# PreToolUse(Bash) guard: the Mac is not a runtime.
#
# Everything that RUNS the product now lives on the sandbox box (`pnpm env:*`, see
# .claude/skills/dev/SKILL.md). This blocks the local runtimes that (a) melt a laptop
# already at 92% disk and 86% swap, or (b) destroy state other windows are using.
#
# Blocks only what actually hurts. Building, testing, linting, type-checking, git and
# every read-only docker command still run locally — that is the point of the split.
#
# Mirrors .claude/hooks/guard-compose.sh. Exit 2 = block and show stderr to the model.
# ── Self-test ─────────────────────────────────────────────────────────────────────
# `bash .claude/hooks/guard-runtime.sh --self-test`. Mirrors scripts/lib/wt-lease.sh's
# --self-test. A guard is only as good as its ALLOW list: the blocks are easy to get
# right and the false positives are what make people disable the thing.
if [ "${1:-}" = "--self-test" ]; then
	self=""
	case "${BASH_SOURCE[0]}" in
	/*) self="${BASH_SOURCE[0]}" ;;
	*) self="$PWD/${BASH_SOURCE[0]}" ;;
	esac
	pass=0
	fail=0
	t() { # <block|allow> <command>
		local payload got rc
		payload="$(printf '{"tool_name":"Bash","tool_input":{"command":%s}}' \
			"$(printf '%s' "$2" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")"
		printf '%s' "$payload" | ALETHIA_LOCAL_DEV= bash "$self" >/dev/null 2>&1
		rc=$?
		[ "$rc" = 2 ] && got=block || got=allow
		if [ "$got" = "$1" ]; then
			pass=$((pass + 1))
		else
			fail=$((fail + 1))
			echo "  ✗ want=$1 got=$got : $2"
		fi
	}

	t block 'pnpm dev:up'
	t block 'PORT=3100 pnpm dev:up'
	t block 'pnpm dev:stack'
	t block 'pnpm dev:console'
	t block 'pnpm compose:up'
	t block 'pnpm db:reset'
	t block 'docker compose down -v'
	t block 'docker compose -f docker-compose.dev.yml down --volumes'
	t block 'cd apps/console && next dev --turbopack'
	t block 'npx turbo dev'
	# The reason quoted spans are NOT stripped before matching:
	t block 'sh -c "pnpm dev:up"'
	t block "bash -lc 'next dev'"

	# Everything the split is supposed to leave alone.
	t allow 'pnpm build'
	t allow 'pnpm -F console test'
	t allow 'pnpm -F console check-types'
	t allow 'pnpm lint'
	t allow 'git status'
	t allow 'docker compose ps'
	t allow 'docker compose logs -f'
	t allow 'docker compose down'
	t allow 'pnpm env:up'
	t allow 'pnpm env:push --watch'
	t allow 'pnpm env:reap'
	t allow 'pnpm dev:doctor'
	t allow 'pnpm dev:runner'
	t allow 'pnpm wt foo'
	t allow 'pnpm db:up'

	echo "  ${pass} passed, ${fail} failed"
	[ "$fail" -eq 0 ]
	exit $?
fi

input="$(cat)"

# Read the COMMAND FIELD, not the raw payload. guard-worktree.sh's R-MAIN scanned the
# whole JSON and consequently rejected any Write/Edit whose *content* mentioned a
# blocked phrase — including edits to its own message. Don't repeat that here.
if command -v jq >/dev/null 2>&1; then
	cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
else
	cmd="$(printf '%s' "$input" |
		grep -oE '"command"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"' |
		sed -E 's/^"command"[[:space:]]*:[[:space:]]*"//; s/"$//' |
		sed -e 's/\\"/"/g' -e 's/\\\\/\\/g')"
fi
[ -n "$cmd" ] || exit 0

# Matching is on the command text, INCLUDING inside quotes. So
# `echo "pnpm dev:up is blocked"` is refused even though it starts nothing. That is
# deliberate and follows the same asymmetry the other guards state: a spurious BLOCK is
# recoverable (reword, or use the escape hatch), a spurious ALLOW is not — and the
# alternative, stripping quoted spans before matching, would wave through
# `sh -c "pnpm dev:up"` and `bash -lc 'next dev'`, which are exactly what this exists to
# stop. Exercised both ways by --self-test.

# Escape hatch. MUST be exported before `claude` starts — a PreToolUse hook is spawned
# before the Bash tool runs, so an inline `ALETHIA_LOCAL_DEV=1 pnpm dev:up` prefix is
# never in this process's environment. (That prefix works for .githooks/*, which git
# spawns itself; it cannot work here. Saying so precisely matters — advice that looks
# like an escape hatch but silently does nothing is worse than no advice.)
[ "${ALETHIA_LOCAL_DEV:-}" = "1" ] && exit 0

block() {
	echo "BLOCKED: $1" >&2
	echo "" >&2
	echo "  → $2" >&2
	echo "" >&2
	echo "  Why: the Mac stopped being a runtime (CLAUDE.md → Running the app). It keeps the" >&2
	echo "  editor, git, and the cheap checks; the product runs on the sandbox box." >&2
	echo "  Deliberate local run: export ALETHIA_LOCAL_DEV=1 BEFORE launching claude." >&2
	exit 2
}

# ── Destructive first: these take other people's state with them ──────────────────
# `down -v` deletes the named volumes, and docker-compose.yml pins `name: alethia`, so
# one window's reset wipes the database every other window is using.
if printf '%s' "$cmd" | grep -Eq 'docker(-|[[:space:]]+)compose\b[^&;|]*[[:space:]]down\b[^&;|]*[[:space:]]-v\b|docker(-|[[:space:]]+)compose\b[^&;|]*[[:space:]]--volumes\b'; then
	block "\`docker compose down -v\` deletes the shared alethia volumes — every window's database, not just yours." \
		"Reset only YOUR environment's database: pnpm env:up --fresh"
fi

if printf '%s' "$cmd" | grep -Eq '(^|[^a-zA-Z0-9_-])pnpm[[:space:]]+db:reset\b'; then
	block "\`pnpm db:reset\` is \`docker compose down -v\` — it wipes the volume shared by every window." \
		"Reset only YOUR environment's database: pnpm env:up --fresh"
fi

# ── Local runtimes ────────────────────────────────────────────────────────────────
if printf '%s' "$cmd" | grep -Eq '(^|[^a-zA-Z0-9_-])pnpm[[:space:]]+dev:up\b'; then
	block "\`pnpm dev:up\` runs the console on this Mac." "pnpm env:up"
fi

if printf '%s' "$cmd" | grep -Eq '(^|[^a-zA-Z0-9_-])pnpm[[:space:]]+dev:stack\b'; then
	block "\`pnpm dev:stack\` runs four dockerised \`next dev\` servers with polling file watchers on this Mac." \
		"pnpm env:up   (inotify works natively on the box — no polling tax)"
fi

if printf '%s' "$cmd" | grep -Eq '(^|[^a-zA-Z0-9_-])pnpm[[:space:]]+dev:console\b|(^|[^a-zA-Z0-9_-])pnpm[[:space:]]+dev\b[[:space:]]*$'; then
	block "that starts a local dev server." "pnpm env:up"
fi

# Bare runners, however they are reached. `pnpm -F console dev`, `npx next dev`, etc.
if printf '%s' "$cmd" | grep -Eq '(^|[^a-zA-Z0-9_-])(next|turbo)[[:space:]]+dev\b'; then
	block "that starts a local dev server." "pnpm env:up"
fi

# compose:up is lock-guarded and safe from a races point of view, but it still builds
# production images on a laptop that has no room for them.
if printf '%s' "$cmd" | grep -Eq '(^|[^a-zA-Z0-9_-])pnpm[[:space:]]+compose:up'; then
	block "\`pnpm compose:up\` builds and runs the production images on this Mac." \
		"pnpm env:up   (or, if you genuinely need the production image path, run it on the box: pnpm env:ssh)"
fi

exit 0
