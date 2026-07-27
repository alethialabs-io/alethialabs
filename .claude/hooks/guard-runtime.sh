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
	# The reason quoted spans are NOT stripped before matching. No shell/exec verb is in
	# the inspect allowlist, so all of these still have an executable remainder.
	t block 'sh -c "pnpm dev:up"'
	t block "bash -lc 'next dev'"
	t block 'env FOO=1 pnpm dev:up'
	t block 'nohup pnpm dev:up &'
	t block 'echo x && pnpm dev:up'

	# Inspecting a blocked command is data, not execution. Refusing these made it
	# impossible to find or fix the docs that recommend them.
	t allow 'grep -n "turbo dev" README.md'
	t allow "rg 'pnpm dev:up' --files-with-matches"
	t allow 'git grep -n "next dev"'
	t allow 'cat docs.md | grep "pnpm compose:up"'
	t allow "sed -i '' 's/turbo dev/pnpm env:up/' README.md"

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
	# Blocking the teardown for a stack you may start is backwards. `dev:stack` itself
	# stays blocked; its sub-commands do not start anything.
	t allow 'pnpm dev:stack:logs'
	t allow 'pnpm dev:stack:down'
	t allow 'pnpm dev:runner:logs'
	t allow 'pnpm dev:runner:down'
	t block 'pnpm dev:stack'
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

# Matching is on the command text, INCLUDING inside quotes: stripping quoted spans would
# wave through `sh -c "…"` and `bash -lc '…'`, which are exactly what this exists to stop.
#
# But quote-inclusive matching alone was too blunt. It refused three legitimate operations
# in a single session — grepping the docs for a blocked command, and twice writing one into
# a file from a heredoc — all while fixing the very docs that recommend those commands.
# "Reword it or restart claude" is not a reasonable answer to `grep -n "turbo dev" README.md`.
#
# So: if the command's leading word is a SEARCH-OR-PRINT tool, its arguments are data, not
# something about to run, and the segment is skipped. The allowlist is deliberately tiny and
# contains no shell/exec verb — `sh`, `bash`, `zsh`, `eval`, `env`, `xargs`, `nohup` are all
# absent, so the smuggling cases stay blocked. Both directions are pinned by --self-test.
INSPECT_RE='^[[:space:]]*(sudo[[:space:]]+)?(grep|egrep|fgrep|rg|ag|ack|sed|awk|cut|sort|uniq|comm|diff|jq|yq|cat|bat|head|tail|less|more|wc|tr|column|printf|echo|find|fd|git[[:space:]]+grep|git[[:space:]]+log)\b'

# Split on shell separators and drop the inspect-only segments. What remains is the text
# that could actually execute something.
exec_text=""
while IFS= read -r seg; do
	printf '%s' "$seg" | grep -Eq "$INSPECT_RE" && continue
	exec_text="$exec_text
$seg"
done <<SEGMENTS
$(printf '%s' "$cmd" | tr ';&|' '\n')
SEGMENTS
# A command that is nothing but inspection has no executable remainder — allow it.
printf '%s' "$exec_text" | grep -q '[^[:space:]]' || exit 0
cmd="$exec_text"

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

# `dev:stack` only — NOT `dev:stack:logs` or `dev:stack:down`. `\b` matches at the k/:
# boundary, so the original rule caught the sub-commands too: it blocked tailing a stack
# and, worse, blocked TEARING ONE DOWN. Refusing the cleanup path for something you are
# permitted to start (with the escape hatch) leaves the machine worse off than not
# guarding at all. The trailing class is what excludes the sub-commands.
if printf '%s' "$cmd" | grep -Eq '(^|[^a-zA-Z0-9_-])pnpm[[:space:]]+dev:stack([^:[:alnum:]]|$)'; then
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
