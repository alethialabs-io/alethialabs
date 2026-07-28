#!/usr/bin/env bash
# PreToolUse(Bash) guard: no raw `docker compose … up`.
#
# Still has a distinct job alongside guard-runtime.sh: that hook blocks `pnpm compose:up`,
# but a bare `docker compose up -d postgres` is not a pnpm script and slips past it. The
# compose project name is hardcoded (`name: alethia`), so every window shares ONE stack and
# two concurrent bring-ups race the same builder.
#
# IT USED TO BE A DEAD END. The message said "use `pnpm compose:up`" — which guard-runtime.sh
# now blocks. The only remediation offered led straight into a second refusal, with no third
# suggestion. Being told no twice with no way forward is how a guard gets switched off; it
# now points at what actually works.
#
# Brought up to the standard of the other two guards: reads the COMMAND FIELD (never the raw
# payload — scanning the whole JSON is what made guard-worktree's R-MAIN reject edits whose
# content merely mentioned a phrase), skips search-or-print invocations, has an escape hatch,
# and ships a --self-test.

if [ "${1:-}" = "--self-test" ]; then
	self="${BASH_SOURCE[0]}"
	case "$self" in /*) ;; *) self="$PWD/$self" ;; esac
	pass=0
	fail=0
	t() {
		local got rc
		printf '{"tool_name":"Bash","tool_input":{"command":%s}}' \
			"$(printf '%s' "$2" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" |
			ALETHIA_LOCAL_DEV= bash "$self" >/dev/null 2>&1
		rc=$?
		[ "$rc" = 2 ] && got=block || got=allow
		if [ "$got" = "$1" ]; then pass=$((pass + 1)); else
			fail=$((fail + 1))
			echo "  ✗ want=$1 got=$got : $2"
		fi
	}

	t block 'docker compose up'
	t block 'docker compose up -d postgres'
	t block 'docker compose --profile enterprise up -d openfga'
	t block 'docker compose -f docker-compose.dev.yml up --build'
	t block 'docker-compose up'

	# Read-only verbs, and the teardown — never blocked. Refusing `down` would leave no
	# way to clean up what you were permitted to start.
	t allow 'docker compose ps'
	t allow 'docker compose logs -f'
	t allow 'docker compose down'
	t allow 'docker compose config -q'
	t allow 'docker ps'
	# Inspection is data, not execution — the same carve-out guard-runtime.sh makes.
	t allow 'grep -n "docker compose up" README.md'
	t allow 'echo "docker compose up is blocked"'

	echo "  ${pass} passed, ${fail} failed"
	[ "$fail" -eq 0 ]
	exit $?
fi

input="$(cat)"

if command -v jq >/dev/null 2>&1; then
	cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
else
	cmd="$(printf '%s' "$input" |
		grep -oE '"command"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"' |
		sed -E 's/^"command"[[:space:]]*:[[:space:]]*"//; s/"$//' |
		sed -e 's/\\"/"/g' -e 's/\\\\/\\/g')"
fi
[ -n "$cmd" ] || exit 0

# One variable for "I am deliberately running this locally", shared with guard-runtime.sh
# rather than a separate one per guard. Must be exported before `claude` starts.
[ "${ALETHIA_LOCAL_DEV:-}" = "1" ] && exit 0

# Searching for the string is not running it.
printf '%s' "$cmd" | grep -Eq '^[[:space:]]*(grep|egrep|rg|ag|sed|awk|cat|echo|printf|head|tail|jq)\b' && exit 0

# `docker compose` (or `docker-compose`) … then `up` as a word, allowing flags in between.
# `[^&;|"]*` keeps the match inside one command string so it cannot bleed across a separator.
if printf '%s' "$cmd" | grep -Eq 'docker(-|[[:space:]]+)compose\b[^&;|"]*[[:space:]]up\b'; then
	{
		echo "BLOCKED: don't bring the compose stack up directly."
		echo ""
		echo "  The project name is hardcoded (\`name: alethia\`), so every window shares ONE"
		echo "  stack — two concurrent bring-ups race the same builder."
		echo ""
		echo "  → To run the app:          pnpm env:up      (on the box, not here)"
		echo "  → Backends only, locally:  pnpm db:up       (postgres + migrate)"
		echo "  → To see what is up:       pnpm compose:ps  ·  pnpm compose:logs"
		echo ""
		echo "  Deliberate local run: export ALETHIA_LOCAL_DEV=1 BEFORE launching claude."
	} >&2
	exit 2
fi
exit 0
