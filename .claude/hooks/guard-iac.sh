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

	# The lifecycle wrappers are ALLOWED by decision (see the header). What must stay
	# blocked is raw tofu — that is the difference between "reap the sandbox" and "apply
	# arbitrary infrastructure". env.sh owns the who-holds-what check these skip.
	t allow 'pnpm env:box'
	t allow 'pnpm env:reap --now'
	t allow 'bash scripts/env.sh box --fresh'
	# Neighbouring env:* commands must stay usable — they are the whole point of the box.
	t allow 'pnpm env:up'
	t allow 'pnpm env:status'
	t allow 'pnpm env:down'
	t allow 'pnpm env:push'
	t allow 'pnpm env:logs'
	t allow 'pnpm env:check'
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

# ── THE WRAPPERS ARE DELIBERATELY ALLOWED NOW — read this before "fixing" it ──────
#
# `pnpm env:box` and `pnpm env:reap` shell out to tofu from inside scripts/env.sh, so no
# PreToolUse hook can see the real command. They were matched by name here after that
# bypass was found. They are now allowed again, ON PURPOSE, by the maintainer's decision:
# the box has to be reapable and restorable without a human in the loop for the cost model
# to work at all.
#
# THIS IS NOT THE OLD OVERSIGHT REGROWN. What that hole meant was "an agent can apply
# arbitrary infrastructure"; raw tofu/terraform apply and destroy — including the
# flag-first forms — are still blocked below, so that remains impossible.
#
# The narrow risk this re-opens is one instance REAPING A BOX ANOTHER IS USING. A hook
# cannot judge that; it has no idea who holds which environment. scripts/env.sh can, and
# does: cmd_reap refuses when another owner's env was recently active, `--now` included.
# That check is the compensating control, and it lives where the information is.
#
# ── the original finding, kept because it is the reason this file exists ──────────
# THE WRAPPER IS THE BYPASS.
#
# Matching `tofu`/`terraform` in the command text is necessary but NOT sufficient: the
# repo ships pnpm scripts that shell out to tofu from INSIDE a script, where no PreToolUse
# hook can see them. `pnpm env:box` runs `tofu -chdir=… apply` (scripts/env.sh) and
# `pnpm env:reap` runs `tofu -chdir=… destroy` — neither command string contains the word
# "tofu", so this hook and the settings.json deny rules both waved them straight through.
#
# That was not theoretical: `require_box`'s own error message instructed agents to run
# `pnpm env:box`, and from a worktree (empty tofu state) that apply would have created a
# SECOND server plus duplicate tunnel and DNS records, breaking dev.alethialabs.io.
#
# So the wrappers are named explicitly. scripts/env.sh ALSO refuses these two commands
# when an agent is driving — a guard the wrapped script enforces itself cannot be dodged
# by finding yet another wrapper, and this list cannot be kept exhaustive by inspection.
if printf '%s' "$cmd" | grep -Eq '(^|[^a-zA-Z0-9_./-])(tofu|terraform)\b[^&;|]*[[:space:]](apply|destroy)\b' ||
	printf '%s' "$cmd" | grep -Eq '(^|[^a-zA-Z0-9_./-])(tofu|terraform)\b[^&;|]*[[:space:]]plan\b[^&;|]*[[:space:]]-destroy\b' ||
	false; then
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
