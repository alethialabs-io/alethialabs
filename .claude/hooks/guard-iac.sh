#!/usr/bin/env bash
# PreToolUse(Bash) guard: agents do not apply or destroy infrastructure.
#
# WHY A HOOK WHEN A DENY RULE ALREADY EXISTS:
#   `.claude/settings.json` denies `Bash(tofu apply:*)`. Permission rules match a command
#   PREFIX, so that covers `tofu apply` and misses everything with a flag first —
#   including the two forms this repo actually uses:
#
#       tofu -chdir=infra/sandbox apply                        (scripts/env.sh, env:box)
#       tofu -chdir=infra/sandbox destroy -target=hcloud_server.sandbox   (env:reap)
#
#   Three of five realistic forms bypassed the rule. The reap path could have DESTROYED a
#   server straight past it. Matching shell text by prefix is inherently leaky; a hook can
#   look at the whole command, so the deny rules stay as defence-in-depth and this is the
#   layer that actually holds.
#
# The rule itself is infra/README.md's: `tofu apply` and `plan -destroy` are human actions.
# The maintainer's escape is ALETHIA_ALLOW_IAC=1, exported before `claude` starts.
#
# Reads and inspection are untouched: init, validate, fmt, plan, show, output, state list.

if [ "${1:-}" = "--self-test" ]; then
	self="${BASH_SOURCE[0]}"
	case "$self" in /*) ;; *) self="$PWD/$self" ;; esac
	pass=0
	fail=0
	t() {
		local got rc
		printf '{"tool_name":"Bash","tool_input":{"command":%s}}' \
			"$(printf '%s' "$2" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" |
			ALETHIA_ALLOW_IAC= bash "$self" >/dev/null 2>&1
		rc=$?
		[ "$rc" = 2 ] && got=block || got=allow
		if [ "$got" = "$1" ]; then pass=$((pass + 1)); else
			fail=$((fail + 1))
			echo "  ✗ want=$1 got=$got : $2"
		fi
	}

	# The forms the prefix-matching deny rule already caught.
	t block 'tofu apply'
	t block 'tofu apply tfplan'
	t block 'terraform apply -auto-approve'
	t block 'tofu destroy'

	# The forms it MISSED — the whole reason this exists.
	t block 'tofu -chdir=infra/sandbox apply'
	t block 'tofu -chdir=infra/sandbox apply -var "image=123"'
	t block 'tofu -chdir=infra/sandbox destroy -target=hcloud_server.sandbox'
	t block 'terraform -chdir=x apply'
	t block 'cd infra/sandbox && tofu apply'
	t block 'TF_LOG=debug tofu apply'
	# `plan -destroy` is a destroy plan; infra/README.md forbids it explicitly.
	t block 'tofu plan -destroy'
	t block 'tofu -chdir=infra/cp-hetzner plan -destroy'

	# Read-only IaC must stay usable — this is how you review before a human applies.
	t allow 'tofu init'
	t allow 'tofu init -backend=false'
	t allow 'tofu validate'
	t allow 'tofu fmt -recursive'
	t allow 'tofu plan'
	t allow 'tofu -chdir=infra/sandbox plan -out=tfplan'
	t allow 'tofu show -json tfplan'
	t allow 'tofu output -raw server_ipv4'
	t allow 'tofu state list'
	t allow 'tofu version'
	# Inspection is data, not execution.
	t allow 'grep -rn "tofu apply" infra/README.md'
	t allow 'echo "tofu apply is a human action"'
	# Unrelated.
	t allow 'pnpm build'
	t allow 'git status'

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

# Maintainer escape, for a deliberately instructed named operation. Must be EXPORTED
# before `claude` starts — a PreToolUse hook is spawned before the Bash tool runs.
[ "${ALETHIA_ALLOW_IAC:-}" = "1" ] && exit 0

# Searching for the string is not running it.
printf '%s' "$cmd" | grep -Eq '^[[:space:]]*(grep|egrep|rg|ag|sed|awk|cat|echo|printf|head|tail|jq|find)\b' && exit 0

# `tofu`/`terraform` … `apply` or `destroy` anywhere after it, whatever flags intervene.
# `[^&;|]*` keeps the match inside one command segment.
if printf '%s' "$cmd" | grep -Eq '(^|[^a-zA-Z0-9_./-])(tofu|terraform)\b[^&;|]*[[:space:]](apply|destroy)\b' ||
	printf '%s' "$cmd" | grep -Eq '(^|[^a-zA-Z0-9_./-])(tofu|terraform)\b[^&;|]*[[:space:]]plan\b[^&;|]*[[:space:]]-destroy\b'; then
	{
		echo "BLOCKED: applying or destroying infrastructure is a human action."
		echo ""
		echo "  infra/README.md: \`tofu apply\` and \`plan -destroy\` are run by a human, from the"
		echo "  correct branch, with the required -vars. An agent reviews the plan; it does not"
		echo "  execute it."
		echo ""
		echo "  → Review instead:  tofu -chdir=<dir> plan -out=tfplan  ·  tofu show -json tfplan"
		echo "  → Then ask the maintainer to run the apply."
		echo ""
		echo "  This catches the flag-first forms a permission rule cannot:"
		echo "    tofu -chdir=<dir> apply   ·   tofu -chdir=<dir> destroy -target=…"
		echo ""
		echo "  Deliberate, instructed operation: export ALETHIA_ALLOW_IAC=1 BEFORE launching claude."
	} >&2
	exit 2
fi
exit 0
