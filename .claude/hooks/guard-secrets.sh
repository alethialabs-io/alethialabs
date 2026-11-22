#!/usr/bin/env bash
# PreToolUse(Bash) guard: a secret may be USED, never PRINTED into the transcript.
#
# The maintainer's rule (2026-11-22): agents may operate every Alethia product and service —
# applies, deploys, Stripe, Cloudflare, the prod secret vault — "without actually getting
# tokens in your transcript, but being able to use them". scripts/creds.py (`pnpm creds`) is
# the way to USE one: it puts the value in a child's environment and redacts the child's
# output. This hook is the other half: it refuses the commands whose whole effect is to print
# secret material where a transcript captures it, and names the broker command instead.
#
# It is NOT a permission check. Nothing here refuses an action; it refuses a RENDERING of a
# credential. Every refusal names a way to do the same work without the value on screen.
#
#   S-DUMPENV   `printenv`, a bare `env`, `export -p`, a bare `set`/`declare -p|-x` — they print
#               every exported variable, which on this Mac includes tokens.
#   S-XTRACE    `bash -x`, `sh -x`, `set -x`, `set -o xtrace` — tracing prints every expanded
#               variable (a lane leaked hcloud and Cloudflare tokens exactly this way).
#   S-VAULT     reading a secret store to stdout: `aws secretsmanager get-secret-value`,
#               `aws ssm get-parameter(s)` with decryption, `security find-generic-password -w|-g`,
#               `tofu|terraform state pull`. The broker reads these itself.
#   S-CREDFILE  printing a credential file: cat/less/more/head/tail/bat/strings/xxd/od/base64/
#               grep/rg/awk/sed
#               of .env (not .env.example), secrets.local.env, *.tfvars, *.tfstate, .netrc,
#               *.pem / *.key / id_rsa / id_ed25519, credentials(.json), gh's hosts.yml.
#   S-ECHO      echo/printf of a variable whose NAME says it is a secret (…TOKEN, …SECRET…,
#               …PASSWORD…, …API_KEY…, …PRIVATE_KEY…, …ACCESS_KEY…).
#   S-LITERAL   a literal credential in the command text: sk_/rk_ live|test keys, whsec_,
#               ghp_/gho_/ghu_/ghs_/ghr_/github_pat_, AKIA/ASIA key ids, sk-ant-, xox?- tokens.
#               It is already in the transcript by then; refusing stops it spreading to argv,
#               shell history and the PR you were about to write it into.
#
# BOUNDARIES — deliberately not caught (stated so nobody reads this as "secrets are safe"):
#   · a value printed by a program as a SIDE effect (an API response, a verbose log). Run such
#     programs under `pnpm creds …` and the redactor masks known values and token shapes.
#   · `tofu output -json|-raw`, which can print a sensitive output — too common in legitimate
#     work to refuse; prefer naming the output and piping it straight into its consumer.
#   · Read/Edit tool calls on credential files — the permission deny rules in
#     .claude/settings.json cover those; this hook sees Bash only.
#   · text built at run time (`eval`, a variable holding the command).
#
# Crash direction is fail-open like every guard here (no hook sets onFailure: block). There is
# no escape hatch: there is always a way to do the work without printing the value.

if [ "${1:-}" = "--self-test" ]; then
	self="${BASH_SOURCE[0]}"
	case "$self" in /*) ;; *) self="$PWD/$self" ;; esac
	pass=0
	fail=0
	t() {
		local got rc
		printf '{"tool_name":"Bash","tool_input":{"command":%s}}' \
			"$(printf '%s' "$2" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" |
			bash "$self" >/dev/null 2>&1
		rc=$?
		[ "$rc" = 2 ] && got=block || got=allow
		if [ "$got" = "$1" ]; then pass=$((pass + 1)); else
			fail=$((fail + 1))
			echo "  ✗ want=$1 got=$got : $2"
		fi
	}
	# Assembled at run time so this file itself carries no literal credential shape.
	sl="sk_""live_""abcdefghijklmnop"
	gp="ghp_""abcdefghijklmnopqrstuvwxyz0123456789"
	ak="AKIA""ABCDEFGHIJKLMNOP"

	# S-DUMPENV
	t block 'printenv'
	t block 'printenv HCLOUD_TOKEN'
	t block 'env'
	t block 'env | grep TOKEN'
	t block 'export -p'
	t block 'declare -x'
	t block 'set'
	t allow 'env FOO=1 pnpm build'
	t allow 'env -u HCLOUD_TOKEN hcloud server list'
	t allow 'set -euo pipefail; echo ok'
	t allow 'pnpm env:status'
	# S-XTRACE
	t block 'bash -x scripts/env.sh box'
	t block 'sh -x ./run.sh'
	t block 'set -x; tofu plan'
	t block 'set -o xtrace'
	t block 'bash -euxo pipefail scripts/x.sh'
	t allow 'bash -e scripts/x.sh'
	t allow 'bash -n .claude/hooks/guard-secrets.sh'
	# S-VAULT
	t block 'aws secretsmanager get-secret-value --secret-id alethia/prod/env'
	t block 'aws --profile alethia-sso secretsmanager get-secret-value --secret-id x'
	t block 'aws ssm get-parameter --name /x --with-decryption'
	t block 'security find-generic-password -s alethia-creds -a cloudflare/X -w'
	t block 'tofu -chdir=infra/github state pull'
	t allow 'aws secretsmanager list-secrets'
	t allow 'aws secretsmanager describe-secret --secret-id x'
	t allow 'pnpm creds prod-env -- node scripts/x.mjs'
	t allow 'tofu -chdir=infra/github state list'
	# S-CREDFILE
	t block 'cat .env'
	t block 'cat apps/console/.env.local'
	t block 'head -5 deploy/prod/secrets.local.env'
	t block 'cat infra/sandbox/terraform.tfvars'
	t block 'less infra/sandbox/terraform.tfstate'
	t block 'cat ~/.netrc'
	t block 'cat ~/.config/gh/hosts.yml'
	t block 'base64 key.pem'
	t allow 'cat .env.example'
	t allow 'cat deploy/prod/secrets.local.env.example'
	t allow 'cat README.md'
	t allow 'grep -n TOKEN scripts/env.sh'
	t block 'grep STRIPE .env'
	t block 'sed -n 1,5p apps/console/.env.local'
	# S-ECHO
	t block 'echo $CLOUDFLARE_API_TOKEN'
	t block 'printf "%s" "${STRIPE_SECRET_KEY}"'
	t block 'echo "key=$AWS_SECRET_ACCESS_KEY"'
	t allow 'echo $HOME'
	t allow 'echo "token refreshed"'
	t allow 'curl -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user'
	# S-LITERAL
	t block "stripe customers list --api-key $sl"
	t block "git remote set-url origin https://$gp@github.com/x/y"
	t block "AWS_ACCESS_KEY_ID=$ak aws s3 ls"
	t allow 'git log --oneline -5'
	t allow 'grep -rn "sk_live_" docs/'

	echo "  ${pass} passed, ${fail} failed"
	[ "$fail" -eq 0 ]
	exit $?
fi

command -v jq >/dev/null 2>&1 || exit 0
cmd="$(jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$cmd" ] || exit 0

refuse() { # <rule> <what> <instead>
	printf 'guard-secrets %s: %s\n  Instead: %s\n  (Secrets are used through `pnpm creds <profile> -- <cmd>`, never printed. `pnpm creds --list` shows profiles.)\n' \
		"$1" "$2" "$3" >&2
	exit 2
}

# Split into simple segments on ; && || | and newlines, so a rule reads one command at a time.
segments="$(printf '%s\n' "$cmd" | sed -E 's/(\&\&|\|\||;|\|)/\n/g')"

# S-LITERAL first: it reads the whole text, quotes included.
lit='(^|[^A-Za-z0-9_])((sk|rk)_(live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(AKIA|ASIA)[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{10,}|xox[abposr]-[A-Za-z0-9-]{10,})'
if printf '%s' "$cmd" | grep -qE "$lit"; then
	refuse S-LITERAL "the command contains a literal credential." \
		"store it once (the maintainer runs \`! pnpm creds --set <profile>\`) and reference the profile."
fi

# S-XTRACE: anywhere in the text.
if printf '%s' "$cmd" | grep -qE '(^|[[:space:];&|(])(ba|z|k|da)?sh[[:space:]]+-[a-wyzA-Z]*x|(^|[[:space:];&|(])set[[:space:]]+(-[a-wyzA-Z]*x|-o[[:space:]]+xtrace)'; then
	refuse S-XTRACE "shell tracing prints every expanded variable, tokens included." \
		"run without -x; add targeted echo lines for the non-secret values you need."
fi

secret_name='[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*'
credfile='(^|[[:space:]/~])(\.env(\.[A-Za-z0-9_-]+)*|secrets\.local\.env|[^[:space:]]*\.tfvars|[^[:space:]]*\.tfstate(\.backup)?|\.netrc|[^[:space:]]*\.pem|[^[:space:]]*\.key|id_rsa|id_ed25519|credentials(\.json)?|hosts\.yml)([[:space:]]|$)'

while IFS= read -r seg; do
	# Trim and drop leading VAR=value assignments.
	seg="$(printf '%s' "$seg" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
	words="$(printf '%s' "$seg" | sed -E 's/^([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*//')"
	first="${words%%[[:space:]]*}"
	rest="${words#"$first"}"
	rest="$(printf '%s' "$rest" | sed -E 's/^[[:space:]]+//')"
	case "$first" in
	printenv)
		refuse S-DUMPENV "\`printenv\` prints environment values." \
			"test presence without the value: \`[ -n \"\${VAR:-}\" ] && echo set\`." ;;
	env)
		# A bare env (or env with only flags and no command) dumps the environment.
		if [ -z "$rest" ] || ! printf '%s' "$rest" | grep -qE '(^|[[:space:]])[^-[:space:]][^=[:space:]]*([[:space:]]|$)|='; then
			refuse S-DUMPENV "a bare \`env\` prints every exported variable." \
				"name the variable you need and test presence: \`[ -n \"\${VAR:-}\" ]\`."
		fi ;;
	export)
		[ "$rest" = "-p" ] || [ -z "$rest" ] &&
			refuse S-DUMPENV "\`export -p\` prints every exported variable." "test the one variable you need." ;;
	declare | typeset)
		printf '%s' "$rest" | grep -qE '^-[a-zA-Z]*[xp][a-zA-Z]*$|^$' &&
			refuse S-DUMPENV "\`$first $rest\` prints variables and their values." "test the one variable you need." ;;
	set)
		[ -z "$rest" ] &&
			refuse S-DUMPENV "a bare \`set\` prints every shell variable." "test the one variable you need." ;;
	aws)
		if printf '%s' "$rest" | grep -qE '(^|[[:space:]])secretsmanager[[:space:]].*get-secret-value|(^|[[:space:]])ssm[[:space:]]+get-parameters?([[:space:]].*)?--with-decryption'; then
			refuse S-VAULT "this prints a secret value from the vault." \
				"\`pnpm creds prod-env -- <cmd>\` (or a profile for that secret) puts it in the child's env."
		fi ;;
	security)
		if printf '%s' "$rest" | grep -qE '^find-(generic|internet)-password([[:space:]].*)?[[:space:]]-[a-zA-Z]*[wg]'; then
			refuse S-VAULT "\`security … -w\` prints a Keychain password." "\`pnpm creds <profile> -- <cmd>\`."
		fi ;;
	tofu | terraform)
		if printf '%s' "$rest" | grep -qE '(^|[[:space:]])state[[:space:]]+pull'; then
			refuse S-VAULT "\`state pull\` prints raw state, which holds every sensitive attribute." \
				"\`state list\` / \`state show <addr>\` (sensitive values masked), or \`output <name>\`."
		fi ;;
	cat | less | more | head | tail | bat | strings | xxd | od | base64 | nl | tac | grep | rg | awk | sed)
		if printf ' %s ' "$rest" | grep -qE "$credfile" && ! printf '%s' "$rest" | grep -qE '\.(example|sample|template)([[:space:]]|$)'; then
			refuse S-CREDFILE "\`$first\` would print a credential file." \
				"pass the file to the program that consumes it, or list its KEYS: \`cut -d= -f1 <file>\`."
		fi ;;
	echo | printf)
		if printf '%s' "$rest" | grep -qE "\\\$\\{?$secret_name"; then
			refuse S-ECHO "this prints a variable whose name marks it as a secret." \
				"test presence: \`[ -n \"\${VAR:-}\" ] && echo set\`."
		fi ;;
	esac
done <<<"$segments"

exit 0
