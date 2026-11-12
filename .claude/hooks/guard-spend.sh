#!/usr/bin/env bash
# PreToolUse(Bash) guard: agents spend money only inside a budget the maintainer set.
#
# The maintainer delegated everything except two things: spend beyond a budget (this file) and
# irreversible deletion (.claude/hooks/guard-destroy.sh). The envelope is EUR 30 per ROLLING 7
# days, across every instance on this machine. It is a constant below, with NO env-var override:
# escape hatches are the maintainer's, and raising the budget is a reviewed PR.
#
# THE LEDGER: ~/.alethia/spend-ledger.jsonl — outside the repo, so it survives worktrees and
# every instance shares it. One JSON line per charge. `pnpm spend:status` prints the window.
#
# A charge is taken at PreToolUse, BEFORE the command runs, and is never refunded: not when the
# command fails (a failed `env:box` may still have created a server), and not when it NEVER RUNS
# at all — a sibling hook refused it, or the user declined the permission prompt. Over-counting is
# the conservative direction. A refusal exits 2 and names the action, its price, the rolling total
# and the budget.
#
# THE LEDGER FAILS CLOSED FOR A CHARGE. A priced command is refused when the ledger directory
# cannot be written, the ledger exists but cannot be read or written, a line in it does not parse,
# the append fails (a full disk), or the appended charge does not read back. "charged" is printed
# only after the read-back. A command with no price never opens the ledger.
#
# CRASH DIRECTION IS FAIL-OPEN, deliberately: a crash (exit other than 0/2) is an allow, because no
# hook sets `onFailure: "block"` and a guard bug must never brick every Bash call. Every refusal
# here is an explicit exit 2. The one input it cannot work without is jq: with no jq the command
# cannot be read, so any payload that MENTIONS a priced or refused action is refused (R-NOJQ)
# rather than allowed blind.
#
# ── THE PRICE TABLE (cents; each line says where the number comes from) ─────────────────────────
#   C-BOX        100   `pnpm env:box` — PER BRING-UP, not per hour. A cpx42 sandbox at EUR 0.1114/h
#                      (infra/sandbox, CLAUDE.md §3); the env:timer LaunchAgent reaps it after 90 idle
#                      minutes, so one bring-up is a working session and EUR 1 buys ~9 box-hours. A
#                      box kept busy longer is under-charged and a no-op `env:box` on a live box is
#                      charged anyway; both are accepted for an estimate. Any spelling that runs
#                      the script counts: /abs/path/pnpm, npx pnpm, corepack pnpm. REFUSED outright
#                      when the reap LaunchAgent is not installed — without it a box bills
#                      EUR 69.49/month until a human notices.
#   C-NIGHTLY     50   `gh workflow run e2e-nightly.yml` with no heavy input — the hetzner green
#                      floor: a small k3s cluster for about an hour plus a bucket (estimate from the
#                      floor's shape; the nightly's own cost ceiling is the hard bound).
#               +1500  for EACH heavy input, PER PROVIDER the run reaches: full_bar, fabric_demo,
#                      keyless_db, secrets_xacct, xacct_registry, cli_demo_grid, and dimension=
#                      maxconfig|addons|full (the input's own description: "heavy + costly"). A
#                      managed-cloud max-config apply (EKS/GKE/AKS + a managed DB + 18 add-ons) for
#                      a 3–6 h run is EUR 10–20; 15 is the midpoint. cli_demo_grid reaches FOUR
#                      providers (hetzner, aws, gcp, azure), everything else one.
#   C-AI          10   `gh workflow run e2e-ai-nightly.yml` — real-model tokens, cents per run.
#   C-BYOMYSQL   200   `gh workflow run byo-users-managed-mysql.yml` — one Aurora MySQL db.t4g.medium
#                      and one RDS MySQL db.t4g.micro for about an hour, created and deleted by the
#                      run (#6536). Under USD 0.10 in fact; priced high on purpose.
#   C-LOCALE2E  1500   scripts/e2e/{provisioning,keyless-db,registry,secrets}-e2e.sh run locally:
#                      the same real-cloud applies as one heavy nightly leg.
#   C-HCLOUD     100   `hcloud --context alethia-e2e|alethia-sandbox <resource> create` — the
#                      same order of cost as one sandbox bring-up.
#   C-RERUN            `gh run rerun <id>` — the run's workflow is looked up over the REST API and
#                      priced from the same table: free → 0, prod → refused, e2e-ai → 10,
#                      byo-users-managed-mysql → 200. An
#                      e2e-nightly rerun is charged per "Provision" job it runs again (all of them;
#                      only the failed ones with --failed; the one named with --job): 50 for a
#                      SCHEDULED run (the floor is the only scheduled dimension) and 1550 for a
#                      dispatched one, because a run object carries no inputs and a dispatch may
#                      have been heavy. A rerun with no run id, or whose lookup fails, is refused
#                      (R-RERUN).
#
# ── ALWAYS REFUSED (no price makes these an agent's call) ───────────────────────────────────────
#   R-PROD       a production deploy/release/infra workflow dispatch. Production ships ONLY
#                through promotion merges (guard-merge.sh); a deploy-console dispatch would also
#                skip the release-gate receipt.
#   R-WORKFLOW   a dispatch the guard cannot price: a workflow not in the table below, a numeric
#                workflow id, `--json` inputs on stdin, or a raw `gh api …/dispatches` call.
#   R-NIGHTLY    e2e-nightly with alibaba_allow_prepaid (~USD 150/month, non-refundable) or
#                azure_redis_allow_known_bad (a measured capacity failure, orphan risk).
#   R-VARS       `gh variable set|delete` of E2E_* or INFRA_*_APPLY, a bulk `--env-file` set,
#                or the same through `gh api …/actions/variables`. A repo variable persists into
#                every SCHEDULED run — the 2026-09-25 leak ran fabric on all four clouds.
#   R-HCLOUD     any hcloud mutation without an explicit disposable --context (the default
#                context on this Mac is another company's production), or with HCLOUD_TOKEN set.
#   R-CLOUDWRITE aws/gcloud/az/aliyun verbs that create or modify. Reads (describe/list/get/show,
#                secretsmanager get-secret-value, s3 ls, auth/config) pass. An unrecognised verb
#                is refused: for a spend class the safe reading of "unknown" is "write".
#   R-STRIPE     the stripe CLI with --live, or any sk_live_/rk_live_ key in a command.
#   R-VERCEL     `vercel … --prod` / `--target production`, `vercel promote|rollback`.
#   R-REAP       anything that stops the box being reaped: `env:box` without the LaunchAgent,
#                `pnpm env:timer off`, touching ALETHIA_REAP_AFTER_MIN, or unloading/editing
#                ~/Library/LaunchAgents/io.alethialabs.sandbox-reap.plist.
#   R-LEDGER     writing, moving or deleting the ledger (that would reset the budget).
#   R-BUDGET     a charge that would take the rolling 7-day total over the budget.
#
# FREE AND ALLOWED: release-gate.yml, ci.yml and the other free workflows in the table, a rerun
# of one of them, gh run cancel, pnpm env:up|push|logs|status|down|reap, every read.
#
# gh's global flags before the subcommand are parsed by lib/cmdline.sh, so a command spelled that
# way is priced like any other.
#
# BOUNDARIES — deliberately NOT caught here:
#   · spend inside a script file, an alias, or text built at run time (`eval`).
#   · Write/Edit tool calls on the plist or the ledger (this hook sees Bash only).
#   · cloud consoles, the Stripe/Vercel MCP tools, anything that is not a Bash command.
#   · the price is an ESTIMATE taken before the run; the ledger is not reconciled with invoices.

SPEND_BUDGET_EUR_7D=30
SPEND_WINDOW_SEC=604800

_self="${BASH_SOURCE[0]}"
case "$_self" in */*) HOOK_DIR="${_self%/*}" ;; *) HOOK_DIR="." ;; esac
# shellcheck source=lib/cmdline.sh
. "$HOOK_DIR/lib/cmdline.sh"

LEDGER_DIR="$HOME/.alethia"
LEDGER="$LEDGER_DIR/spend-ledger.jsonl"
REAP_PLIST="$HOME/Library/LaunchAgents/io.alethialabs.sandbox-reap.plist"

# ── the workflow table ──────────────────────────────────────────────────────────────────────────
# EVERY workflow in .github/workflows must be classified here — a dispatch can only start a
# workflow_dispatch one, but `gh run rerun` can re-run any of them. --self-test checks both
# directions (an unclassified workflow, and an entry naming no file).
#   free     costs nothing worth metering (CI minutes on the repo's own runners)
#   prod     ships or changes production — refused (R-PROD)
#   nightly  priced from its inputs (C-NIGHTLY)
#   ai       C-AI
#   byomysql C-BYOMYSQL
wf_class() {
	case "$1" in
	ci.yml | release-gate.yml | codeql.yml | validate-console.yml | validate-runner.yml | workflow-health.yml | \
		merge-signal-health.yml | addon-render-determinism.yml | catalog-drift.yml | compat-drift.yml | \
		posthog-error-issues.yml | gate-fixme-currency.yml | template-proof-currency.yml | programme.yml | \
		go-floors-rerecord.yml | e2e-issuer-health.yml | e2e-orphan-reaper.yml | hcloud-zone-probe.yml | \
		branch-flow-guard.yml | capabilities-security.yml | cla.yml | close-on-dev-merge.yml | byo-admission-kind.yml)
		echo free
		;;
	deploy-*.yml | release-cli.yml | release-runner.yml | release-please.yml | publish-cli-release-metadata.yml | \
		mirror-cli.yml | infra-*.yml)
		echo prod
		;;
	e2e-nightly.yml) echo nightly ;;
	e2e-ai-nightly.yml) echo ai ;;
	byo-users-managed-mysql.yml) echo byomysql ;;
	*) echo unknown ;;
	esac
}

# ── money ──────────────────────────────────────────────────────────────────────────────────────
eur() { printf '%d.%02d' $(($1 / 100)) $(($1 % 100)); }

now_epoch() {
	NOW="$(date +%s)"
}

# window_cents — sets WINDOW_CENTS: the sum of every charge in the last 7 days. FAILS (1) when the
# ledger exists and cannot be read, or holds a line that does not parse — the caller refuses then:
# reading an unreadable ledger as "empty" is how a budget stops being enforced without a sign.
window_cents() {
	WINDOW_CENTS=0
	[ -e "$LEDGER" ] || return 0
	[ -r "$LEDGER" ] || return 1
	WINDOW_CENTS="$(awk -v since=$((NOW - SPEND_WINDOW_SEC)) '
		/^[[:space:]]*$/ { next }
		!/"ts":[0-9]+/ || !/"cents":[0-9]+/ { bad++; next }
		{
			ts = $0; sub(/.*"ts":/, "", ts); sub(/[^0-9].*/, "", ts)
			c = $0; sub(/.*"cents":/, "", c); sub(/[^0-9].*/, "", c)
			if (ts + 0 >= since) s += c
		}
		END { if (bad) exit 3; print s + 0 }' "$LEDGER" 2>/dev/null)" || return 1
	case "$WINDOW_CENTS" in '' | *[!0-9]*) return 1 ;; esac
	return 0
}

refuse() { # <rule-id> <what> [why]
	{
		echo "BLOCKED (guard-spend ${1}): ${2}"
		if [ -n "${3:-}" ]; then
			echo ""
			echo "  ${3}"
		fi
		echo ""
		echo "  Spend outside the EUR ${SPEND_BUDGET_EUR_7D}/7-day envelope is the maintainer's: ask the maintainer."
		echo "  Ledger: pnpm spend:status"
	} >&2
	exit 2
}

CHARGES=()
charge() { # <rule-id> <cents> <label>
	CHARGES+=("$1|$2|$3")
}

json_str() { # escape for a JSON string, no fork
	local s="$1"
	s="${s//\\/\\\\}"
	s="${s//\"/\\\"}"
	s="${s//$'\n'/ }"
	s="${s//$'\t'/ }"
	s="${s//$'\r'/ }"
	printf '%s' "${s:0:240}"
}

settle() {
	[ ${#CHARGES[@]} -gt 0 ] || return 0
	local c id cents label total=0 desc=""
	for c in "${CHARGES[@]}"; do
		cents="${c#*|}"
		cents="${cents%%|*}"
		total=$((total + cents))
	done
	mkdir -p "$LEDGER_DIR" 2>/dev/null
	if ! [ -d "$LEDGER_DIR" ] || ! [ -w "$LEDGER_DIR" ]; then
		# @mut ledger-dir
		refuse R-LEDGER "the spend ledger directory $LEDGER_DIR cannot be created or written, so this charge cannot be recorded. Nothing was run." \
			"Fix the directory (permissions, a full disk) and run the command again."
	fi
	# Serialise the check-and-append across instances. A lock older than 60 s is a crashed hook.
	local lock="$LEDGER_DIR/spend-ledger.lock" tries=0
	while ! mkdir "$lock" 2>/dev/null; do
		tries=$((tries + 1))
		if [ "$tries" -gt 50 ]; then
			if [ -n "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
				rmdir "$lock" 2>/dev/null
				continue
			fi
			refuse R-BUDGET "the spend ledger is locked by another instance; nothing was charged or run." "Try again in a moment."
		fi
		sleep 0.1
	done
	now_epoch
	if [ -e "$LEDGER" ] && ! [ -w "$LEDGER" ]; then
		rmdir "$lock" 2>/dev/null
		# @mut ledger-unwritable
		refuse R-LEDGER "the spend ledger $LEDGER cannot be written, so this charge cannot be recorded. Nothing was run."
	fi
	if ! window_cents; then
		rmdir "$lock" 2>/dev/null
		# @mut ledger-unreadable
		refuse R-LEDGER "the spend ledger $LEDGER cannot be read or holds a line that does not parse, so the 7-day total is unknown. Nothing was run." \
			"Inspect it with pnpm spend:status; a ledger that cannot be read must not count as an empty one."
	fi
	local budget=$((SPEND_BUDGET_EUR_7D * 100)) after=$((WINDOW_CENTS + total)) before_cents="$WINDOW_CENTS"
	if [ "$after" -gt "$budget" ]; then
		rmdir "$lock" 2>/dev/null
		for c in "${CHARGES[@]}"; do
			id="${c%%|*}"
			label="${c##*|}"
			cents="${c#*|}"
			cents="${cents%%|*}"
			desc="$desc
    $label — EUR $(eur "$cents") ($id)"
		done
		refuse R-BUDGET "this command costs EUR $(eur "$total"):$desc" \
			"Rolling 7-day total EUR $(eur "$WINDOW_CENTS") + EUR $(eur "$total") = EUR $(eur "$after"), over the EUR ${SPEND_BUDGET_EUR_7D} budget."
	fi
	local utc session
	utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	session="${CLAUDE_CODE_SESSION_ID:-${CODEX_SESSION_ID:-}}"
	for c in "${CHARGES[@]}"; do
		id="${c%%|*}"
		label="${c##*|}"
		cents="${c#*|}"
		cents="${cents%%|*}"
		if ! printf '{"ts":%s,"utc":"%s","cents":%s,"eur":"%s","rule":"%s","action":"%s","session":"%s","cwd":"%s"}\n' \
			"$NOW" "$utc" "$cents" "$(eur "$cents")" "$id" "$(json_str "$label")" "$(json_str "$session")" "$(json_str "$CWD")" >>"$LEDGER" 2>/dev/null; then
			rmdir "$lock" 2>/dev/null
			# @mut ledger-append
			refuse R-LEDGER "could not append this charge to $LEDGER (a full disk, or the file vanished), so it cannot be recorded. Nothing was run."
		fi
	done
	# Read the charge BACK before saying it was taken: a write that "succeeded" into the void
	# (a ledger replaced by /dev/null, a filesystem that drops writes) must not count as recorded.
	if ! window_cents || [ "$WINDOW_CENTS" != $((before_cents + total)) ]; then
		rmdir "$lock" 2>/dev/null
		# @mut ledger-verify
		refuse R-LEDGER "the charge did not read back from $LEDGER (expected EUR $(eur $((before_cents + total))), read EUR $(eur "${WINDOW_CENTS:-0}")). Nothing was run."
	fi
	rmdir "$lock" 2>/dev/null
	echo "guard-spend: charged EUR $(eur "$total") — rolling 7-day total EUR $(eur "$after") of EUR ${SPEND_BUDGET_EUR_7D}." >&2
}

# ── helpers ────────────────────────────────────────────────────────────────────────────────────
EXPORTS=""
env_lookup() { # <NAME> — ENV_VAL from the prefix, an earlier export, or the hook's env
	local name="$1" line
	ENV_VAL=""
	while IFS= read -r line; do
		case "$line" in "$name="*) ENV_VAL="${line#*=}" ;; esac
	done <<<"$EXPORTS$SEG_ENV"
	if [ -z "$ENV_VAL" ] && [ -n "${!name:-}" ]; then ENV_VAL="${!name}"; fi
	ENV_VAL="${ENV_VAL//\"/}"
	ENV_VAL="${ENV_VAL//\'/}"
}

nonflag_words() { # NF: words after TOK[0] that are neither flags nor a known flag's value
	local i n=${#TOK[@]} a skip=0
	NF=()
	for ((i = 1; i < n; i++)); do
		a="${TOK[$i]}"
		if [ "$skip" = 1 ]; then
			skip=0
			continue
		fi
		case "$a" in
		--profile | --region | --output | -o | --endpoint-url | --query | --color | --context | --project | --zone | \
			--subscription | -g | --resource-group | -n | --name | --format | --account | --configuration) skip=1 ;;
		-*) ;;
		*) NF+=("$a") ;;
		esac
	done
}

# ── rules ──────────────────────────────────────────────────────────────────────────────────────
# Anchored at the start of the segment: the program that RUNS must be pnpm/npm/yarn or the script
# itself — `git commit -m "… pnpm env:box …"` is text, and charging it would be a false spend.
ENVBOX_RE='^(pnpm|yarn|npm)[[:space:]]([^;&|]*[[:space:]])?env:box([[:space:]]|$)|^((ba)?sh[[:space:]]+)?[^[:space:]]*scripts/env\.sh[[:space:]]+box([[:space:]]|$)'
TIMER_OFF_RE='^(pnpm|yarn|npm)[[:space:]]([^;&|]*[[:space:]])?env:timer[[:space:]]+off([[:space:]]|$)|^((ba)?sh[[:space:]]+)?[^[:space:]]*scripts/env\.sh[[:space:]]+timer[[:space:]]+off([[:space:]]|$)'
LOCAL_E2E_RE='^((ba)?sh[[:space:]]+)?[^[:space:]]*scripts/e2e/(provisioning|keyless-db|registry|secrets)-e2e\.sh'
# A program that EDITS or REMOVES a file, for the plist/ledger/threshold rules.
MUTATORS=" rm mv cp sed perl tee truncate unlink shred plutil defaults chmod chflags ln install dd ed ex vi vim nano : "

# box_seg — sets BSEG: SEG with a leading npx/pnpx/bunx/corepack wrapper dropped and the program
# reduced to its basename, so `/opt/homebrew/bin/pnpm env:box`, `npx pnpm env:box` and
# `corepack pnpm env:box` all read as `pnpm env:box`.
box_seg() {
	local s="$SEG" first
	first="${s%%[[:space:]]*}"
	case "${first##*/}" in npx | pnpx | bunx | corepack)
		s="${s#"$first"}"
		s="${s#"${s%%[![:space:]]*}"}"
		first="${s%%[[:space:]]*}"
		;;
	esac
	# @mut box-wrapper
	s="${first##*/}${s#"$first"}"
	BSEG="$s"
}

rule_box() {
	box_seg
	if [[ "$BSEG" =~ $TIMER_OFF_RE ]]; then
		refuse R-REAP "\`env:timer off\` removes the only thing that reaps an idle box." \
			"The box bills by the hour it EXISTS (EUR 69.49/month left up). Reap by hand with pnpm env:reap --now; leave the timer on."
	fi
	if [[ "$BSEG" =~ $ENVBOX_RE ]]; then
		[ -f "$REAP_PLIST" ] ||
			refuse R-REAP "\`env:box\` with no reap LaunchAgent installed ($REAP_PLIST is missing)." \
				"Install the idle reaper first — pnpm env:timer — so a forgotten box dies within 90 minutes instead of billing all month."
		charge C-BOX 100 "env:box (sandbox bring-up)"
	fi
	return 0
}

# The threshold: SETTING it (a prefix or an export) or EDITING it with a file-mutating program.
# Mentioning it — a commit message, a grep — is text and passes.
rule_reap_settings() {
	local raw="$1" prog="${TOK[0]##*/}"
	case "$SEG_ENV$EXPORTS" in *ALETHIA_REAP_AFTER_MIN=*)
		refuse R-REAP "the command sets ALETHIA_REAP_AFTER_MIN, the idle threshold the reaper uses." \
			"Changing when the box is reaped changes what it costs; that is a reviewed change to scripts/env.sh, not a command."
		;;
	esac
	case "$raw" in *ALETHIA_REAP_AFTER_MIN*)
		case "$MUTATORS" in *" $prog "*)
			refuse R-REAP "\`$prog\` edits ALETHIA_REAP_AFTER_MIN, the idle threshold the reaper uses." \
				"Changing when the box is reaped changes what it costs; that is a reviewed change to scripts/env.sh, not a command."
			;;
		esac
		;;
	esac
	case "$raw" in *io.alethialabs.sandbox-reap*)
		if [ "$prog" = launchctl ]; then
			case "${TOK[1]:-}" in list | print) return 0 ;; esac
		else
			case "$MUTATORS" in *" $prog "*) ;; *) return 0 ;; esac
		fi
		refuse R-REAP "\`$prog\` changes the sandbox-reap LaunchAgent." \
			"pnpm env:timer [on|status] manages it; turning it off or editing it is the maintainer's."
		;;
	esac
	return 0
}

# Redirection onto the ledger or the plist, judged on the RAW segment BEFORE the inspection
# carve-out: `echo x > ~/.alethia/spend-ledger.jsonl` is an ordinary echo otherwise.
rule_redirect() {
	local raw="$1" t
	while [[ "$raw" =~ \>+[[:space:]]*([^[:space:]\>]+) ]]; do
		t="${BASH_REMATCH[1]}"
		raw="${raw#*"${BASH_REMATCH[0]}"}"
		case "$t" in
		*spend-ledger*) refuse R-LEDGER "a redirection overwrites the spend ledger, which would reset the budget." ;;
		*io.alethialabs.sandbox-reap*) refuse R-REAP "a redirection overwrites the sandbox-reap LaunchAgent." ;;
		esac
	done
	return 0
}

rule_ledger() {
	local raw="$1" a prog="${TOK[0]##*/}"
	case "$raw" in *spend-ledger*)
		case "$MUTATORS" in *" $prog "*)
			refuse R-LEDGER "\`$prog\` writes, moves or deletes the spend ledger." "Read it with pnpm spend:status."
			;;
		esac
		;;
	esac
	case "${TOK[0]##*/}" in rm | mv | unlink | shred | truncate)
		for a in "${TOK[@]:1}"; do
			case "$a" in -*) continue ;; esac
			cmdline_has_var "${a#\$HOME}" && continue
			cmdline_abspath "$a" "${DIR:-/}"
			case "$LEDGER" in "$ABSPATH" | "$ABSPATH"/*)
				refuse R-LEDGER "\`${TOK[0]} $a\` deletes the spend ledger, which would reset the budget."
				;;
			esac
		done
		;;
	esac
	return 0
}

# gh workflow run <workflow> [flags] — price it, or refuse it.
rule_workflow() {
	local rest wf="" inputs=() i n a k v
	rest="${SEG#*workflow}"
	rest="${rest#"${rest%%[![:space:]]*}"}"
	rest="${rest#run}"
	rest="${rest#"${rest%%[![:space:]]*}"}"
	case "$rest" in
	\"*)
		wf="${rest#\"}"
		wf="${wf%%\"*}"
		;;
	\'*)
		wf="${rest#\'}"
		wf="${wf%%\'*}"
		;;
	*) wf="${rest%%[[:space:]]*}" ;;
	esac
	# flags precede the workflow too (`gh workflow run --ref dev x.yml`): find the first non-flag
	case "$wf" in -*)
		n=${#TOK[@]}
		wf=""
		for ((i = 3; i < n; i++)); do
			a="${TOK[$i]}"
			case "$a" in
			--ref | -r | --repo | -R) i=$((i + 1)) ;;
			-f | -F | --field | --raw-field) i=$((i + 1)) ;;
			-*) ;;
			*)
				wf="$a"
				break
				;;
			esac
		done
		;;
	esac
	[ -n "$wf" ] || refuse R-WORKFLOW "\`gh workflow run\` with no workflow the guard can read." \
		"Name the workflow file explicitly: gh workflow run <file>.yml"
	local file="$wf"
	case "$wf" in
	*.yml | *.yaml) file="${wf##*/}" ;;
	*[!0-9]*)
		file="$(wf_file_for_name "$wf")"
		;;
	*)
		refuse R-WORKFLOW "\`gh workflow run $wf\` names a workflow by numeric id, which the guard cannot price." \
			"Use the file name: gh workflow run <file>.yml"
		;;
	esac
	local class
	class="$(wf_class "$file")"
	case "$class" in
	free) return 0 ;;
	prod)
		refuse R-PROD "\`gh workflow run $file\` ships or changes PRODUCTION." \
			"Production ships only through promotion merges (dev → staging → main, guard-merge.sh). A direct deploy-console dispatch also skips the release-gate receipt."
		;;
	unknown)
		refuse R-WORKFLOW "\`gh workflow run $wf\` is not in guard-spend.sh's workflow table, so it cannot be priced." \
			"Classify the workflow in wf_class() in a reviewed PR."
		;;
	esac
	case " $SEG " in *" --json"*)
		refuse R-WORKFLOW "\`gh workflow run $file --json\` reads its inputs from stdin, which the guard cannot price." \
			"Pass each input as -f name=value."
		;;
	esac
	# collect the -f/-F inputs
	n=${#TOK[@]}
	for ((i = 3; i < n; i++)); do
		a="${TOK[$i]}"
		case "$a" in
		-f | -F | --field | --raw-field) inputs+=("${TOK[$((i + 1))]:-}") && i=$((i + 1)) ;;
		--field=* | --raw-field=*) inputs+=("${a#*=}") ;;
		-f?* | -F?*) inputs+=("${a#-?}") ;;
		esac
	done
	if [ "$class" = ai ]; then
		charge C-AI 10 "gh workflow run $file"
		return 0
	fi
	if [ "$class" = byomysql ]; then
		charge C-BYOMYSQL 200 "gh workflow run $file"
		return 0
	fi
	# nightly
	local heavy=0 providers=1 names="" maxcfg=0
	for a in "${inputs[@]}"; do
		k="${a%%=*}"
		v="${a#*=}"
		# GitHub coerces a boolean input case-insensitively, so `full_bar=TRUE` is a true
		# @mut nightly-case
		v="$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')"
		case "$k=$v" in
		alibaba_allow_prepaid=true)
			refuse R-NIGHTLY "e2e-nightly with alibaba_allow_prepaid=true buys a PREPAID resource (~USD 150/month, a teardown may not refund it)." ;;
		azure_redis_allow_known_bad=true)
			refuse R-NIGHTLY "e2e-nightly with azure_redis_allow_known_bad=true buys an apply in a region with a MEASURED capacity failure (orphan risk, #3078)." ;;
		full_bar=true | dimension=maxconfig | dimension=addons | dimension=full)
			# full_bar=true and dimension=full|maxconfig|addons are the same max-config run: once.
			if [ "$maxcfg" = 0 ]; then
				maxcfg=1
				heavy=$((heavy + 1))
				names="$names $k"
			fi
			;;
		fabric_demo=true | secrets_xacct=true | xacct_registry=true)
			heavy=$((heavy + 1))
			names="$names $k"
			;;
		cli_demo_grid=true)
			heavy=$((heavy + 1))
			providers=4
			names="$names $k"
			;;
		keyless_db=?*)
			heavy=$((heavy + 1))
			names="$names $k"
			;;
		esac
	done
	local cents=$((50 + heavy * 1500 * providers))
	charge C-NIGHTLY "$cents" "gh workflow run e2e-nightly.yml (floor + $heavy heavy × $providers provider(s):${names:- none})"
}

wf_file_for_name() { # <workflow name> — print the file whose `name:` it is (or the name back)
	local root="${CLAUDE_PROJECT_DIR:-$HOOK_DIR/../..}" f
	f="$(grep -lE "^name:[[:space:]]*[\"']?$(printf '%s' "$1" | sed 's/[][\.*^$(){}?+|/]/\\&/g')[\"']?[[:space:]]*$" "$root"/.github/workflows/*.yml 2>/dev/null | head -1)"
	if [ -n "$f" ]; then printf '%s' "${f##*/}"; else printf '%s' "$1"; fi
}

# gh run rerun [<run-id>] [--failed] [--job <id>] — price it from the run's own workflow.
# gh_lookup <out-var> <gh args…> — run a read-only gh lookup; on failure set GH_ERR to gh's own
# error line (`HTTP 404: Not Found …`) and return 1. On an HTTP error gh prints the JSON error
# body on STDOUT, so the output is never trusted unless gh exited 0.
gh_lookup() {
	local __var="$1" __out __err __rc
	shift
	__err="$(mktemp "${TMPDIR:-/tmp}/alethia-gh-err.XXXXXX")"
	__out="$(cd "${DIR:-.}" 2>/dev/null && gh "$@" 2>"$__err")"
	__rc=$?
	GH_ERR="$(grep -v '^[[:space:]]*$' "$__err" | head -1)"
	rm -f "$__err"
	if [ "$__rc" != 0 ]; then
		printf -v "$__var" '%s' ""
		[ -n "$GH_ERR" ] || GH_ERR="gh exited $__rc"
		return 1
	fi
	printf -v "$__var" '%s' "$__out"
}

# rerun_repo <owner/repo> — the repository a rerun's `-R/--repo` names (before or after `rerun`).
rerun_repo() { RERUN_REPO="$1"; }

rule_rerun() {
	local i n=${#TOK[@]} a id="" job="" failed=0 info wf ev cls repo jobs count=0 per cents
	RERUN_REPO="$CMDLINE_GH_REPO"
	for ((i = 3; i < n; i++)); do
		a="${TOK[$i]}"
		case "$a" in
		-R | --repo)
			# @mut rerun-repo-after
			rerun_repo "${TOK[$((i + 1))]:-}"
			i=$((i + 1))
			;;
		--repo=*) rerun_repo "${a#--repo=}" ;;
		-R?*) rerun_repo "${a#-R}" ;;
		--failed) failed=1 ;;
		-j | --job)
			job="${TOK[$((i + 1))]:-}"
			i=$((i + 1))
			;;
		--job=*) job="${a#--job=}" ;;
		-*) ;;
		*) [ -n "$id" ] || id="$a" ;;
		esac
	done
	repo="${RERUN_REPO:-"{owner}/{repo}"}"
	if [ -z "$id" ] && [ -n "$job" ]; then
		case "$job" in *[!0-9]*) refuse R-RERUN "\`gh run rerun --job $job\`: the job id is not a number the guard can look up." ;; esac
		gh_lookup id api "repos/$repo/actions/jobs/$job" --jq '.run_id' ||
			refuse R-RERUN "could not look up job $job to find its run, so the rerun cannot be priced: $GH_ERR"
	fi
	case "$id" in "" | *[!0-9]*)
		# @mut rerun-noid
		refuse R-RERUN "\`gh run rerun ${id:-<no id>}\`: the run id is not a literal number the guard can look up before the command runs, so the rerun cannot be priced." \
			"Resolve the id in one command, then rerun it by number in the next: gh run rerun <run-id> [--failed]"
		;;
	esac
	if ! gh_lookup info api "repos/$repo/actions/runs/$id" --jq '.path + " " + .event'; then
		# @mut rerun-lookup-error
		refuse R-RERUN "could not look up run $id${RERUN_REPO:+ in $RERUN_REPO}, so the rerun cannot be priced: $GH_ERR"
	fi
	wf="${info%% *}"
	ev="${info#* }"
	wf="${wf%%@*}"
	wf="${wf##*/}"
	if [ -z "$info" ] || [ -z "$wf" ]; then
		# @mut rerun-lookup
		refuse R-RERUN "could not look up run $id (offline, or not a run in ${RERUN_REPO:-this repository}), so the rerun cannot be priced."
	fi
	cls="$(wf_class "$wf")"
	case "$cls" in
	free) return 0 ;;
	prod)
		# A PULL-REQUEST run of a production workflow is plan/validate-only: every infra-* apply
		# job is gated on a push to main or a dispatch, and infra-templates, infra-e2e-issuer,
		# infra-aws-oidc and infra-sandbox have no apply job at all. Re-running one is a check.
		[ "$ev" = pull_request ] && return 0
		# @mut rerun-prod
		refuse R-PROD "\`gh run rerun $id\` re-runs $wf ($ev), which ships or changes PRODUCTION."
		;;
	unknown) refuse R-WORKFLOW "\`gh run rerun $id\` re-runs $wf, which is not in guard-spend.sh's workflow table." ;;
	ai)
		charge C-RERUN 10 "gh run rerun $id ($wf)"
		return 0
		;;
	byomysql)
		charge C-RERUN 200 "gh run rerun $id ($wf)"
		return 0
		;;
	esac
	# nightly: one charge per Provision job the rerun runs again
	gh_lookup jobs run view "$id" ${RERUN_REPO:+-R "$RERUN_REPO"} --json jobs \
		--jq '.jobs[] | "\(.databaseId)\t\(.conclusion)\t\(.name)"' ||
		refuse R-RERUN "could not list the jobs of run $id, so the rerun cannot be priced: $GH_ERR"
	[ -n "$jobs" ] || refuse R-RERUN "run $id lists no jobs, so the rerun cannot be priced."
	local jid conc name
	while IFS=$'\t' read -r jid conc name; do
		case "$name" in Provision*) ;; *) continue ;; esac
		if [ -n "$job" ]; then
			[ "$jid" = "$job" ] || continue
		elif [ "$failed" = 1 ]; then
			case "$conc" in failure | cancelled | timed_out | startup_failure) ;; *) continue ;; esac
		fi
		count=$((count + 1))
	done <<<"$jobs"
	[ "$count" -gt 0 ] || return 0
	if [ "$ev" = schedule ]; then per=50; else per=1550; fi
	cents=$((count * per))
	charge C-RERUN "$cents" "gh run rerun $id (e2e-nightly, $count Provision job(s), $ev run)"
}

rule_gh() {
	local sub="${TOK[1]:-}" verb="${TOK[2]:-}" a name="" i n path=""
	case "$sub" in
	workflow) [ "$verb" = run ] && rule_workflow ;;
	run) [ "$verb" = rerun ] && rule_rerun ;;
	variable)
		case "$verb" in set | delete | remove) ;; *) return 0 ;; esac
		n=${#TOK[@]}
		for ((i = 3; i < n; i++)); do
			a="${TOK[$i]}"
			case "$a" in
			-f | --env-file)
				[ "$verb" = set ] && refuse R-VARS "\`gh variable set --env-file\` sets variables in bulk from a file the guard cannot read." ;;
			-b | --body | -R | --repo | -e | --env | -o | --org | -v | --visibility | -r | --repos) i=$((i + 1)) ;;
			-*) ;;
			*) [ -n "$name" ] || name="$a" ;;
			esac
		done
		case "$name" in E2E_* | INFRA_*_APPLY)
			refuse R-VARS "\`gh variable $verb $name\` changes a variable every SCHEDULED run reads." \
				"Use the workflow's dispatch inputs, which die with the run. A variable outlives the agent that set it (the 2026-09-25 leak ran fabric on all four clouds)."
			;;
		esac
		;;
	api)
		n=${#TOK[@]}
		for ((i = 2; i < n; i++)); do
			a="${TOK[$i]}"
			case "$a" in
			-X | --method | -H | --header | -f | -F | --field | --raw-field | -q | --jq | --input | -t | --template) i=$((i + 1)) ;;
			-*) ;;
			*)
				path="$a"
				break
				;;
			esac
		done
		path="${path#/}"
		if [[ "$path" =~ actions/workflows/([^/]+)/dispatches ]]; then
			local f="${BASH_REMATCH[1]}"
			case "$(wf_class "$f")" in
			free) ;;
			prod) refuse R-PROD "\`gh api …/workflows/$f/dispatches\` dispatches a PRODUCTION workflow." ;;
			*) refuse R-WORKFLOW "\`gh api …/workflows/$f/dispatches\` dispatches a priced or unknown workflow behind the price table's back." \
				"Use gh workflow run $f -f name=value so the inputs can be priced." ;;
			esac
		fi
		if [[ "$path" =~ actions/variables/(E2E_[A-Za-z0-9_]*|INFRA_[A-Za-z0-9_]*_APPLY)$ ]] || {
			[[ "$path" =~ actions/variables/?$ ]] && case " ${TOK[*]} " in *" name=E2E_"* | *" name=INFRA_"*) true ;; *) false ;; esac
		}; then
			case " ${TOK[*]} " in *" -X GET"* | *" --method GET"*) ;; *)
				case " ${TOK[*]} " in *" -X "* | *" --method "* | *" -f "* | *" -F "* | *" --field "* | *" --raw-field "* | *" --input "*)
					refuse R-VARS "\`gh api\` writes an E2E_*/INFRA_*_APPLY repository variable that every scheduled run reads." ;;
				esac
				;;
			esac
		fi
		;;
	esac
	return 0
}

rule_hcloud() {
	nonflag_words
	local res="${NF[0]:-}" verb="${NF[1]:-}" ctx="" i n=${#TOK[@]}
	case "$res" in "" | context | version | completion | config | help) return 0 ;; esac
	case "$verb" in "" | list | describe | help | ip | ssh | metrics) return 0 ;; esac
	for ((i = 1; i < n; i++)); do
		case "${TOK[$i]}" in
		--context) ctx="${TOK[$((i + 1))]:-}" ;;
		--context=*) ctx="${TOK[$i]#--context=}" ;;
		esac
	done
	if [ -z "$ctx" ]; then
		env_lookup HCLOUD_CONTEXT
		ctx="$ENV_VAL"
	fi
	env_lookup HCLOUD_TOKEN
	[ -z "$ENV_VAL" ] || refuse R-HCLOUD "\`hcloud $res $verb\` with HCLOUD_TOKEN set — a token overrides the context, so the project is unknown."
	case "$ctx" in
	alethia-e2e | alethia-sandbox) ;;
	"") refuse R-HCLOUD "\`hcloud $res $verb\` without --context." \
		"The default hcloud context on this Mac is ANOTHER company's production. Name a disposable project: --context alethia-e2e or --context alethia-sandbox." ;;
	*) refuse R-HCLOUD "\`hcloud --context $ctx $res $verb\` mutates a project that is not disposable." \
		"Only alethia-e2e and alethia-sandbox are agents' to change." ;;
	esac
	[ "$verb" = create ] && charge C-HCLOUD 100 "hcloud --context $ctx $res create"
	return 0
}

rule_cloudwrite() {
	local prog="$1" w svc op last
	nonflag_words
	case "$prog" in
	aws)
		svc="${NF[0]:-}"
		op="${NF[1]:-}"
		case "$svc" in "" | help | configure | sso | sts | --version) return 0 ;; esac
		if [ "$svc" = s3 ]; then
			case "$op" in ls | presign | "") return 0 ;; esac
			last="${NF[${#NF[@]} - 1]}"
			case "$op" in cp | sync) case "$last" in s3://*) ;; *) return 0 ;; esac ;; esac
			refuse R-CLOUDWRITE "\`aws s3 $op\` writes to S3."
		fi
		case "$op" in
		describe-* | list-* | get-* | head-* | lookup-* | search-* | batch-get-* | scan | query | select* | filter-* | \
			validate-* | simulate-* | estimate-* | test-* | preview-* | wait | help | tail | start-query | \
			update-kubeconfig | generate-presigned-url | decode-authorization-message)
			return 0
			;;
		esac
		refuse R-CLOUDWRITE "\`aws $svc $op\` creates or modifies an AWS resource." \
			"Reads (describe-*, list-*, get-*, secretsmanager get-secret-value) are allowed; real-cloud work runs in the e2e workflows under their own cost ceilings."
		;;
	gcloud | az)
		local read=0 write=0
		case "${NF[0]:-}" in "" | config | auth | info | version | help | login | logout | account | extension | components) return 0 ;; esac
		for w in "${NF[@]}"; do
			case "$w" in
			list | describe | show | get-* | print-* | read | tail | query | wait | check-* | exists | explain) read=1 ;;
			create | delete | update | deploy | set | set-* | add | add-* | remove | remove-* | patch | apply | enable | disable | \
				resize | start | stop | restart | reset | import | export | submit | run | attach | detach | move | rename | \
				rollback | upgrade | scale | purge | undelete | migrate | swap | assign | invoke | publish)
				write=1
				;;
			esac
		done
		[ "$write" = 0 ] && [ "$read" = 1 ] && return 0
		refuse R-CLOUDWRITE "\`$prog ${NF[*]}\` creates or modifies a cloud resource (or uses a verb the guard does not recognise as a read)." \
			"Reads (list, describe, show, get-*) are allowed."
		;;
	aliyun)
		case "${NF[0]:-}" in "" | configure | help | version | --version) return 0 ;; esac
		case "${NF[1]:-}" in Describe* | List* | Get* | Query* | Check*) return 0 ;; esac
		refuse R-CLOUDWRITE "\`aliyun ${NF[0]} ${NF[1]:-}\` creates or modifies an Alibaba Cloud resource." \
			"Reads (Describe*, List*, Get*, Query*) are allowed."
		;;
	esac
	return 0
}

rule_stripe() { # raw segment: the key may be in an assignment prefix
	local raw="$1"
	# A key SHAPE, not the prefix: `grep sk_live_` and a commit message naming it are text.
	if [[ "$raw" =~ (sk|rk)_live_[A-Za-z0-9]{8,} ]]; then
		refuse R-STRIPE "the command carries a LIVE Stripe key (sk_live_/rk_live_)." \
			"Live mode moves real money. Use the test key; live-mode operations are the maintainer's."
	fi
	if [ "${TOK[0]##*/}" = stripe ]; then
		case " ${TOK[*]} " in *" --live"*)
			refuse R-STRIPE "\`stripe … --live\` runs against live mode." "Drop --live: the CLI defaults to test mode." ;;
		esac
	fi
	return 0
}

rule_vercel() {
	local i n=${#TOK[@]} at=-1 a
	for ((i = 0; i < n && i < 4; i++)); do
		[ "${TOK[$i]##*/}" = vercel ] && at=$i && break
	done
	[ "$at" -ge 0 ] || return 0
	case "${TOK[$((at + 1))]:-}" in promote | rollback)
		refuse R-VERCEL "\`vercel ${TOK[$((at + 1))]}\` changes what PRODUCTION serves." ;;
	esac
	for ((i = at + 1; i < n; i++)); do
		a="${TOK[$i]}"
		case "$a" in
		--prod | --production | --target=production | --target=prod)
			refuse R-VERCEL "\`vercel … $a\` deploys to PRODUCTION." "Preview deploys are fine; production ships through promotion merges."
			;;
		--target)
			case "${TOK[$((i + 1))]:-}" in production | prod) refuse R-VERCEL "\`vercel … --target production\` deploys to PRODUCTION." ;; esac
			;;
		esac
	done
	return 0
}

# ── main ───────────────────────────────────────────────────────────────────────────────────────
# Words that mark a payload the guard would price or refuse; used only when jq is missing.
NOJQ_RE='env:box|env:timer|env\.sh|workflow run|run rerun|-e2e\.sh|hcloud|aws |gcloud|az |aliyun|stripe|_live_|vercel|variable (set|delete)|REAP_AFTER|sandbox-reap|spend-ledger|actions/workflows'

main() {
	cmdline_read_payload
	if [ -n "$CMDLINE_NO_JQ" ]; then
		if [[ "$CMDLINE_RAW" =~ $NOJQ_RE ]]; then
			# @mut nojq
			refuse R-NOJQ "jq is not installed, so the guard cannot read this command, and it mentions a priced or refused action (${BASH_REMATCH[0]})." \
				"Install jq (brew install jq), then run it again."
		fi
		exit 0
	fi
	[ -n "$CMD" ] || exit 0
	case "$CMD" in
	*env:box* | *env.sh* | *env:timer* | *REAP_AFTER* | *sandbox-reap* | *workflow* | *variable* | *rerun* | *hcloud* | *aws* | \
		*gcloud* | *az* | *aliyun* | *stripe* | *_live_* | *vercel* | *-e2e.sh* | *spend-ledger* | *.alethia*) ;;
	*) exit 0 ;;
	esac
	cmdline_split "$CMD"
	DIR="$CWD"
	local raw prog
	for raw in "${SEGS[@]}"; do
		cmdline_normalise "$raw"
		case "$raw" in *\>*) rule_redirect "$raw" ;; esac
		if [ ${#TOK[@]} -eq 0 ]; then
			[ -n "$SEG_ENV" ] && EXPORTS="$EXPORTS$SEG_ENV"
			rule_reap_settings "$raw"
			continue
		fi
		prog="${TOK[0]##*/}"
		if [ "$prog" = export ]; then
			local a
			for a in "${TOK[@]:1}"; do
				case "$a" in *=*) EXPORTS="$EXPORTS$a"$'\n' ;; esac
			done
			rule_reap_settings "$raw"
			continue
		fi
		if [ "$prog" = cd ]; then
			case "${TOK[1]:-}" in /*) DIR="${TOK[1]}" ;; esac
			continue
		fi
		cmdline_is_inspect && continue
		rule_reap_settings "$raw"
		rule_ledger "$raw"
		rule_stripe "$raw"
		rule_box
		if [[ "$SEG" =~ $LOCAL_E2E_RE ]]; then
			charge C-LOCALE2E 1500 "${BASH_REMATCH[0]} (local real-cloud e2e)"
		fi
		case "$prog" in
		gh) rule_gh ;;
		hcloud) rule_hcloud ;;
		aws | gcloud | az | aliyun) rule_cloudwrite "$prog" ;;
		esac
		rule_vercel
	done
	settle
	exit 0
}

# ── status ─────────────────────────────────────────────────────────────────────────────────────
status() {
	now_epoch
	window_cents
	local budget=$((SPEND_BUDGET_EUR_7D * 100))
	echo "Spend ledger: $LEDGER"
	echo "Budget: EUR ${SPEND_BUDGET_EUR_7D} per rolling 7 days (a constant in .claude/hooks/guard-spend.sh)"
	echo ""
	if [ -f "$LEDGER" ]; then
		awk -v since=$((NOW - SPEND_WINDOW_SEC)) -v now="$NOW" '
			{
				ts = $0; sub(/.*"ts":/, "", ts); sub(/[^0-9].*/, "", ts)
				if (ts + 0 < since) next
				utc = $0; sub(/.*"utc":"/, "", utc); sub(/".*/, "", utc)
				eur = $0; sub(/.*"eur":"/, "", eur); sub(/".*/, "", eur)
				rule = $0; sub(/.*"rule":"/, "", rule); sub(/".*/, "", rule)
				act = $0; sub(/.*"action":"/, "", act); sub(/","session".*/, "", act)
				left = int((ts + 604800 - now) / 3600)
				printf "  %s  EUR %7s  %-11s  %s   (leaves the window in %dh)\n", utc, eur, rule, act, left
				n++
			}
			END { if (n == 0) print "  (no charges in the window)" }' "$LEDGER"
	else
		echo "  (no ledger yet — nothing has been charged)"
	fi
	echo ""
	echo "Rolling 7-day total: EUR $(eur "$WINDOW_CENTS")   remaining: EUR $(eur $((budget > WINDOW_CENTS ? budget - WINDOW_CENTS : 0)))"
	[ -f "$REAP_PLIST" ] && echo "Reap LaunchAgent: installed" || echo "Reap LaunchAgent: NOT installed — env:box is refused until pnpm env:timer"
}

# ── self-test ──────────────────────────────────────────────────────────────────────────────────
# Hermetic: a temp $HOME holds the ledger and (or not) the LaunchAgent plist. Counters live in
# THIS shell and the exit code is the test. `--mutation-test` disables each rule's call sites in
# turn (`refuse R-X` / `charge C-X` → `true`) and requires the self-test to fail for every one.
self_test() {
	local self="$1" tmp home pass=0 fail=0
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT
	home="$tmp/home"
	mkdir -p "$home/Library/LaunchAgents" "$home/.alethia"
	: >"$home/Library/LaunchAgents/io.alethialabs.sandbox-reap.plist"
	local ledger="$home/.alethia/spend-ledger.jsonl"
	# A stub gh for `gh run rerun`: the run lookups below answer from a table, 106 fails.
	mkdir -p "$tmp/stub"
	cat >"$tmp/stub/gh" <<'STUB'
#!/usr/bin/env bash
case "$*" in
*actions/runs/101*) echo ".github/workflows/ci.yml pull_request" ;;
*actions/runs/102*) echo ".github/workflows/deploy-console.yml workflow_dispatch" ;;
*actions/runs/103*) echo ".github/workflows/e2e-ai-nightly.yml schedule" ;;
*actions/runs/104*) echo ".github/workflows/e2e-nightly.yml schedule" ;;
*actions/runs/105*) echo ".github/workflows/e2e-nightly.yml workflow_dispatch" ;;
*actions/runs/107*) echo ".github/workflows/not-in-the-table.yml push" ;;
*actions/runs/108*) echo ".github/workflows/infra-cp-aws.yml pull_request" ;;
*actions/runs/109*) echo ".github/workflows/infra-cp-aws.yml push" ;;
*actions/jobs/5551*) echo 104 ;;
*o/other/actions/runs/110*) echo ".github/workflows/e2e-ai-nightly.yml schedule" ;;
*actions/runs/110*) echo '{"message":"Not Found","status":"404"}'; echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
*actions/runs/111*) exit 0 ;;
*actions/runs/112*) echo ".github/workflows/byo-users-managed-mysql.yml workflow_dispatch" ;;
*actions/runs/106*) echo '{"message":"Not Found","documentation_url":"x","status":"404"}'; echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
"run view 104 "*)
	printf '1\tsuccess\tResolve dimension\n5551\tfailure\tProvision + verify + teardown (real cloud) (hetzner)\n'
	printf '5552\tsuccess\tProvision + verify + teardown (real cloud) (aws)\n5553\tcancelled\tProvision + verify + teardown (real cloud) (gcp)\n'
	printf '9\tfailure\tNightly verdict rollup (5-cloud table + dedup issue)\n'
	;;
"run view 105 "*) printf '7001\tfailure\tProvision + verify + teardown (real cloud) (aws)\n' ;;
*) exit 1 ;;
esac
STUB
	chmod +x "$tmp/stub/gh"
	bad() {
		fail=$((fail + 1))
		echo "  ✗ $*"
		[ -z "${SELFTEST_FAILFAST:-}" ] || exit 1
	}
	run() { # <command> [env…]
		local cmd="$1" payload
		shift
		payload="$(jq -n --arg c "$cmd" --arg d "$tmp" '{tool_name:"Bash",cwd:$d,tool_input:{command:$c}}')"
		printf '%s' "$payload" | env PATH="$tmp/stub:$PATH" HOME="$home" HCLOUD_CONTEXT= HCLOUD_TOKEN= CLAUDE_PROJECT_DIR="$HOOK_ROOT" "$@" \
			bash "$self" >/dev/null 2>"$tmp/stderr"
		RC=$?
	}
	cents_in_ledger() { [ -f "$ledger" ] && awk '{c=$0; sub(/.*"cents":/,"",c); sub(/[^0-9].*/,"",c); s+=c} END{print s+0}' "$ledger" 2>/dev/null || echo 0; }
	# t <block|allow> <command> [env…] — and an allow must charge NOTHING
	t() {
		local want="$1" cmd="$2" got before after
		shift 2
		before="$(cents_in_ledger)"
		run "$cmd" "$@"
		after="$(cents_in_ledger)"
		case "$RC" in 0) got=allow ;; 2) got=block ;; *) got="crash(rc=$RC: $(head -c 200 "$tmp/stderr"))" ;; esac
		if [ "$got" != "$want" ]; then bad "want=$want got=$got : $cmd"; elif [ "$before" != "$after" ]; then
			bad "$cmd charged $((after - before)) cents; want 0"
		else pass=$((pass + 1)); fi
	}
	# c <cents> <command> [env…] — allowed, and charges exactly that much
	c() {
		local want="$1" cmd="$2" before after
		shift 2
		before="$(cents_in_ledger)"
		run "$cmd" "$@"
		after="$(cents_in_ledger)"
		if [ "$RC" = 0 ] && [ $((after - before)) = "$want" ]; then pass=$((pass + 1)); else
			bad "rc=$RC charged $((after - before)) want $want : $cmd"
		fi
		: >"$ledger"
	}

	# ── charges ──
	c 100 'pnpm env:box'
	c 100 'pnpm env:box --fresh'
	c 100 'bash scripts/env.sh box'
	c 50 'gh workflow run e2e-nightly.yml'
	c 50 'gh workflow run e2e-nightly.yml --ref dev -f provider=aws'
	c 1550 'gh workflow run e2e-nightly.yml -f full_bar=true'
	c 1550 'gh workflow run e2e-nightly.yml -f dimension=maxconfig'
	c 1550 'gh workflow run e2e-nightly.yml -f full_bar=true -f dimension=full'
	c 1550 'gh workflow run e2e-nightly.yml -f dimension=full -f full_bar=true'
	c 1550 'gh workflow run e2e-nightly.yml --field keyless_db=postgres'
	c 50 'gh workflow run e2e-nightly.yml -f keyless_db='
	c 1550 'gh workflow run e2e-nightly.yml -f fabric_demo=true'
	# two heavy inputs on one provider: 0.50 + 2 × 15 = 30.50, over the budget on its own
	t block 'gh workflow run e2e-nightly.yml -f fabric_demo=true -f secrets_xacct=true'
	c 1550 'gh workflow run "E2E Nightly (T2 · real cloud)" -f xacct_registry=true'
	c 10 'gh workflow run e2e-ai-nightly.yml'
	c 200 'gh workflow run byo-users-managed-mysql.yml'
	c 200 'gh workflow run byo-users-managed-mysql.yml --ref feat/x'
	c 200 'gh workflow run "BYO users — managed MySQL (AWS)"'
	c 200 'gh run rerun 112'
	t block 'gh workflow run not-in-the-table.yml'
	grep -q 'not in guard-spend.sh' "$tmp/stderr" && pass=$((pass + 1)) || bad "an unclassified dispatch is refused by naming the table: $(cat "$tmp/stderr")"
	c 1500 'bash scripts/e2e/keyless-db-e2e.sh'
	c 1500 './scripts/e2e/provisioning-e2e.sh --provider hetzner'
	c 100 'hcloud --context alethia-e2e server create --name x --type cx22'
	c 100 'HCLOUD_CONTEXT=alethia-sandbox hcloud server create --name x'
	c 200 'pnpm env:box && hcloud --context alethia-e2e volume create --name v --size 10'
	# any spelling that runs the script is charged, and checked for the reaper
	c 100 '/opt/homebrew/bin/pnpm env:box'
	c 100 'npx pnpm env:box'
	c 100 'corepack pnpm env:box'
	c 100 'bash /Users/x/work/app/scripts/env.sh box'
	# boolean inputs are case-insensitive
	c 1550 'gh workflow run e2e-nightly.yml -f full_bar=TRUE'
	# gh's global flags before the subcommand (B1)
	c 1550 'gh -R alethialabs-io/alethialabs workflow run e2e-nightly.yml -f full_bar=true'
	c 50 'gh --repo=o/r workflow run e2e-nightly.yml'
	# gh run rerun is priced from the run it reruns
	c 100 'gh run rerun 104 --failed'
	c 150 'gh run rerun 104'
	c 50 'gh run rerun 104 --job 5552'
	c 50 'gh run rerun --job 5551'
	c 1550 'gh run rerun 105 --failed'
	c 10 'gh run rerun 103'
	c 0 'gh run rerun 101'
	t block 'gh run rerun 102'
	grep -q 'ships or changes PRODUCTION' "$tmp/stderr" && pass=$((pass + 1)) || bad "a production rerun is refused as production: $(cat "$tmp/stderr")"
	t allow 'gh run rerun 108 --failed'
	t block 'gh run rerun 109'
	t block 'gh run rerun "$rid" --failed'
	grep -q 'not a literal number' "$tmp/stderr" && pass=$((pass + 1)) || bad "a variable run id is named as such"
	t block 'gh run rerun 106'
	grep -q 'could not look up run 106' "$tmp/stderr" && pass=$((pass + 1)) || bad "a failed run lookup is refused by name: $(cat "$tmp/stderr")"
	grep -q 'HTTP 404' "$tmp/stderr" && pass=$((pass + 1)) || bad "the lookup failure reports gh's HTTP error: $(cat "$tmp/stderr")"
	grep -q '"message"' "$tmp/stderr" && bad "the HTTP error body must not be read as data: $(cat "$tmp/stderr")" || pass=$((pass + 1))
	# -R/--repo in EITHER position: the run is looked up in the repository named
	t block 'gh run rerun 111'
	grep -q 'offline, or not a run in' "$tmp/stderr" && pass=$((pass + 1)) || bad "an empty lookup answer is refused: $(cat "$tmp/stderr")"
	c 10 'gh run rerun -R o/other 110'
	c 10 'gh run rerun 110 -R o/other'
	c 10 'gh run rerun 110 --repo=o/other'
	c 10 'gh -R o/other run rerun 110'
	t block 'gh run rerun 110'
	grep -q 'HTTP 404' "$tmp/stderr" && pass=$((pass + 1)) || bad "a run absent from the cwd repo is a lookup failure: $(cat "$tmp/stderr")"
	t block 'gh run rerun 107'
	grep -q 'not in guard-spend.sh' "$tmp/stderr" && pass=$((pass + 1)) || bad "an unknown workflow's rerun names the table"
	t block 'gh run rerun'
	grep -q 'rerun <no id>' "$tmp/stderr" && pass=$((pass + 1)) || bad "a rerun with no id is refused by name: $(cat "$tmp/stderr")"
	t block 'gh run rerun --failed'
	# cli_demo_grid reaches four providers: 0.50 + 15 × 4 = 60.50, over the budget on its own
	t block 'gh workflow run e2e-nightly.yml -f dimension=cli-demo -f cli_demo_grid=true'

	# ── the budget: a rolling window, and only the window ──
	now="$(date +%s)"
	printf '{"ts":%s,"cents":2950}\n{"ts":%s,"cents":5000}\n' "$now" $((now - 8 * 86400)) >"$ledger"
	t block 'pnpm env:box'
	grep -q 'EUR 29.50 + EUR 1.00 = EUR 30.50' "$tmp/stderr" && pass=$((pass + 1)) || bad "the refusal names the total and the budget: $(cat "$tmp/stderr")"
	run 'gh workflow run e2e-ai-nightly.yml'
	[ "$RC" = 0 ] && [ "$(cents_in_ledger)" = 7960 ] && pass=$((pass + 1)) || bad "a charge inside the budget is allowed and appended (rc=$RC, ledger=$(cents_in_ledger))"
	printf '{"ts":%s,"cents":2990}\n' "$now" >"$ledger"
	run 'gh workflow run e2e-ai-nightly.yml'
	[ "$RC" = 0 ] && pass=$((pass + 1)) || bad "exactly reaching the budget is allowed"
	: >"$ledger"

	# ── hard refusals ──
	t block 'gh workflow run deploy-console.yml'
	t block 'gh --repo alethialabs-io/alethialabs workflow run deploy-console.yml'
	t block 'gh -R o/r variable set E2E_FABRIC_DEMO --body 1'
	t block 'gh -R o/r api -X POST repos/o/r/actions/workflows/deploy-console.yml/dispatches -f ref=main'
	t block 'npx pnpm env:timer off'
	t block 'gh workflow run deploy-fleet-aws.yml -f x=y'
	t block 'gh workflow run release-cli.yml'
	t block 'gh workflow run infra-cp-hetzner.yml'
	t block 'gh workflow run "Deploy Console"'
	t block 'gh workflow run 123456'
	t block 'gh workflow run not-a-workflow.yml'
	t block 'gh workflow run e2e-nightly.yml --json'
	t block 'gh api -X POST repos/o/r/actions/workflows/deploy-console.yml/dispatches -f ref=main'
	t block 'gh api -X POST repos/o/r/actions/workflows/e2e-nightly.yml/dispatches -f ref=dev'
	t block 'gh workflow run e2e-nightly.yml -f provider=alibaba -f alibaba_allow_prepaid=true'
	t block 'gh workflow run e2e-nightly.yml -f provider=azure -f azure_redis_allow_known_bad=true'
	t block 'gh variable set E2E_FABRIC_DEMO --body 1'
	t block 'gh variable delete E2E_KEYLESS_DB'
	t block 'gh variable set INFRA_CP_AWS_APPLY -b true'
	t block 'gh variable set -f vars.env'
	t block 'gh api -X PATCH repos/o/r/actions/variables/E2E_FABRIC_DEMO -f value=1'
	t block 'gh api repos/o/r/actions/variables -f name=E2E_X -f value=1'
	t block 'hcloud server create --name x'
	t block 'hcloud --context tovr-prod server create --name x'
	t block 'hcloud --context alethia-console-prod firewall add-rule fw'
	t block 'hcloud --context alethia-e2e server create --name x' HCLOUD_TOKEN=abc
	t block 'aws ec2 run-instances --image-id ami-1'
	t block 'aws --region eu-central-1 rds create-db-instance --db-instance-identifier x'
	t block 'aws s3 cp ./f s3://bucket/f'
	t block 'aws iam put-role-policy --role-name x'
	t block 'gcloud compute instances create vm-1'
	t block 'gcloud container clusters resize c --num-nodes 9'
	t block 'gcloud compute frobnicate x'
	t block 'az vm create -n x -g rg'
	t block 'aliyun ecs RunInstances --ImageId x'
	t block 'stripe charges create --amount 100 --live'
	# The fixture keys are ASSEMBLED at run time: a literal key shape in this file is exactly what
	# the gitleaks history scan (rightly) fails a PR on.
	local live="live" sk rk
	sk="sk_${live}_51Habc123XYZ"
	rk="rk_${live}_51Habc123XYZ"
	t block "STRIPE_API_KEY=$sk node scripts/x.mjs"
	t block "curl https://api.stripe.com/v1/charges -u $rk:"
	t block 'vercel deploy --prod'
	t block 'npx vercel --prod'
	t block 'vercel deploy --target production'
	t block 'vercel promote https://x.vercel.app'
	t block 'pnpm env:timer off'
	t block 'bash scripts/env.sh timer off'
	t block 'ALETHIA_REAP_AFTER_MIN=100000 pnpm env:timer'
	t block 'export ALETHIA_REAP_AFTER_MIN=9999'
	t block "sed -i '' 's/ALETHIA_REAP_AFTER_MIN:-90/ALETHIA_REAP_AFTER_MIN:-900/' scripts/env.sh"
	t block 'launchctl bootout gui/501 ~/Library/LaunchAgents/io.alethialabs.sandbox-reap.plist'
	t block 'rm ~/Library/LaunchAgents/io.alethialabs.sandbox-reap.plist'
	t block 'rm ~/.alethia/spend-ledger.jsonl'
	t block 'rm -rf ~/.alethia'
	t block ': > ~/.alethia/spend-ledger.jsonl'
	t block 'echo "{}" > ~/.alethia/spend-ledger.jsonl'
	t block "sed -i '' '1d' ~/.alethia/spend-ledger.jsonl"
	t block 'cat x.plist > ~/Library/LaunchAgents/io.alethialabs.sandbox-reap.plist'
	t block 'plutil -replace StartInterval -integer 99999 ~/Library/LaunchAgents/io.alethialabs.sandbox-reap.plist'
	rm -f "$home/Library/LaunchAgents/io.alethialabs.sandbox-reap.plist"
	t block 'pnpm env:box'
	grep -q 'sandbox-reap.plist is missing' "$tmp/stderr" && pass=$((pass + 1)) || bad "the no-reaper refusal says why"
	: >"$home/Library/LaunchAgents/io.alethialabs.sandbox-reap.plist"

	# ── free, and allowed ──
	t allow 'gh workflow run release-gate.yml -f legs=hero'
	t allow 'gh workflow run ci.yml --ref feat/x'
	t allow 'gh workflow run e2e-orphan-reaper.yml'
	t allow 'gh run rerun 101 --failed'
	t allow 'gh run cancel 123'
	t allow 'gh workflow list'
	t allow 'gh variable list'
	t allow 'gh variable set SOME_OTHER_VAR --body x'
	t allow 'gh api repos/o/r/actions/variables/E2E_FABRIC_DEMO'
	t allow 'pnpm env:up'
	t allow 'pnpm env:push --watch'
	t allow 'pnpm env:logs'
	t allow 'pnpm env:status'
	t allow 'pnpm env:down'
	t allow 'pnpm env:reap --now'
	t allow 'pnpm env:timer'
	t allow 'pnpm env:timer status'
	t allow 'hcloud server list'
	t allow 'hcloud --context alethia-e2e server describe x'
	t allow 'hcloud context list'
	t allow 'hcloud --context alethia-e2e server delete x'
	t allow 'aws ec2 describe-instances'
	t allow 'aws secretsmanager get-secret-value --secret-id x'
	t allow 'aws sts get-caller-identity'
	t allow 'aws s3 ls s3://bucket'
	t allow 'aws s3 cp s3://bucket/f ./f'
	t allow 'aws eks update-kubeconfig --name c'
	t allow 'gcloud compute instances list'
	t allow 'gcloud container clusters get-credentials c --zone z'
	t allow 'gcloud config set project x'
	t allow 'az account show'
	t allow 'az group list'
	t allow 'aliyun ecs DescribeInstances'
	t allow 'stripe listen --forward-to localhost:3000'
	t allow 'stripe charges list'
	t allow 'vercel deploy'
	t allow 'vercel ls'
	t allow 'grep -rn sk_live_ apps/'
	t allow 'grep -n ALETHIA_REAP_AFTER_MIN scripts/env.sh'
	t allow 'cat ~/.alethia/spend-ledger.jsonl'
	t allow 'launchctl list io.alethialabs.sandbox-reap'
	t allow 'echo "gh workflow run deploy-console.yml"'
	t allow 'git status'
	t allow 'pnpm build'
	t allow 'scripts/e2e/provisioning-cleanup.sh'
	# Text that NAMES a priced or refused action is not the action, and is never charged.
	t allow 'git commit -m "harness: pnpm env:box is charged EUR 1; ALETHIA_REAP_AFTER_MIN is guarded"'
	t allow 'gh pr create --title "spend" --body "refuses pnpm env:timer off and edits of io.alethialabs.sandbox-reap"'
	t allow 'git commit -m "never paste sk_live_ keys; the ledger lives at ~/.alethia/spend-ledger.jsonl"'
	t allow 'gh pr view 12 --json body -q .body | grep -n "scripts/e2e/keyless-db-e2e.sh"'
	# heredoc bodies are data unless a shell consumes them; a multi-line quoted body is one segment
	t allow "python3 - <<'EOF'
cfg = ['pnpm env:timer off', 'gh workflow run deploy-console.yml']
EOF"
	t block "bash <<'EOF'
pnpm env:timer off
EOF"
	t allow 'gh issue comment 1 --body "Notes:
hcloud server delete box ran in the e2e project.
gh workflow run deploy-console.yml is the maintainer'"'"'s."'
	c 100 "cat > /tmp/x.md <<EOF
data
EOF
pnpm env:box"

	# ── the workflow table covers the repo, in both directions ──
	local wf f cls
	for wf in "$HOOK_ROOT"/.github/workflows/*.yml; do
		f="${wf##*/}"
		cls="$(wf_class "$f")"
		[ "$cls" != unknown ] && pass=$((pass + 1)) || bad "the workflow $f is not in wf_class() (a rerun can reach any workflow)"
	done
	for f in $(sed -n '/^wf_class() {/,/^}/p' "$self" | grep -oE '[a-z0-9-]+\.yml' | sort -u); do
		[ -f "$HOOK_ROOT/.github/workflows/$f" ] && pass=$((pass + 1)) || bad "wf_class() names $f, which does not exist"
	done

	# ── B3: the ledger fails CLOSED for a charge ──
	now="$(date +%s)"
	printf '{"ts":%s,"cents":2950}\n' "$now" >"$ledger"
	chmod 000 "$ledger"
	t block 'pnpm env:box'
	grep -q 'cannot be written' "$tmp/stderr" && pass=$((pass + 1)) || bad "an unwritable ledger is named: $(cat "$tmp/stderr")"
	chmod 200 "$ledger"
	t block 'pnpm env:box'
	grep -q 'cannot be read or holds a line that does not parse' "$tmp/stderr" && pass=$((pass + 1)) || bad "an unreadable ledger is named: $(cat "$tmp/stderr")"
	chmod 600 "$ledger"
	printf 'this is not a ledger line\n' >>"$ledger"
	t block 'pnpm env:box'
	grep -q 'does not parse' "$tmp/stderr" && pass=$((pass + 1)) || bad "a corrupt line is refused: $(cat "$tmp/stderr")"
	t allow 'git status'
	t allow 'pnpm env:up'
	rm -f "$ledger"
	# the append fails (the path behind a dangling link cannot be created — the shape of a full disk)
	ln -s "$tmp/no-such-dir/ledger" "$ledger"
	t block 'pnpm env:box'
	grep -q 'could not append' "$tmp/stderr" && pass=$((pass + 1)) || bad "a failed append is refused by name: $(cat "$tmp/stderr")"
	grep -q 'charged' "$tmp/stderr" && bad "a failed append must never print charged" || pass=$((pass + 1))
	rm -f "$ledger"
	# the append "succeeds" into the void: the charge must read back
	ln -s /dev/null "$ledger"
	t block 'pnpm env:box'
	grep -q 'did not read back' "$tmp/stderr" && pass=$((pass + 1)) || bad "an append that does not read back is refused: $(cat "$tmp/stderr")"
	rm -f "$ledger"
	# the directory cannot be created
	mv "$home/.alethia" "$home/.alethia.bak"
	: >"$home/.alethia"
	t block 'pnpm env:box'
	grep -q 'directory' "$tmp/stderr" && pass=$((pass + 1)) || bad "an unwritable ledger directory is refused: $(cat "$tmp/stderr")"
	rm -f "$home/.alethia"
	mv "$home/.alethia.bak" "$home/.alethia"

	# ── no jq: a priced command is refused, an ordinary one allowed ──
	mkdir -p "$tmp/nojq"
	ln -sf "$(command -v cat)" "$tmp/nojq/cat"
	nojq() { # <block|allow> <command>
		local payload rc got
		payload="$(jq -n --arg c "$2" '{tool_name:"Bash",cwd:"/tmp",tool_input:{command:$c}}')"
		printf '%s' "$payload" | env PATH="$tmp/nojq" HOME="$home" "$BASH" "$self" >/dev/null 2>"$tmp/stderr"
		rc=$?
		case "$rc" in 0) got=allow ;; 2) got=block ;; *) got="crash($rc)" ;; esac
		[ "$got" = "$1" ] && pass=$((pass + 1)) || bad "no jq: want=$1 got=$got : $2"
	}
	nojq block 'pnpm env:box'
	nojq block 'gh workflow run e2e-nightly.yml -f full_bar=true'
	nojq block 'gh run rerun 104'
	nojq allow 'git status --short'
	nojq allow 'pnpm -F console test'

	# ── the ledger line is well-formed JSON ──
	: >"$ledger"
	run 'pnpm env:box'
	jq -e '.cents == 100 and .rule == "C-BOX" and (.ts | type) == "number" and (.utc | test("Z$"))' "$ledger" >/dev/null 2>&1 &&
		pass=$((pass + 1)) || bad "the ledger line is JSON with ts/utc/cents/rule: $(cat "$ledger")"

	echo "  ${pass} passed, ${fail} failed"
	[ "$fail" -eq 0 ]
}

mutation_test() {
	local self="$1" dir ids id killed=0 survived=0 copy
	dir="$(mktemp -d)"
	trap 'rm -rf "$dir"' EXIT
	mkdir -p "$dir/lib"
	cp "${self%/*}/lib/cmdline.sh" "$dir/lib/"
	ids="$(grep -vE '^[[:space:]]*#' "$self" | grep -oE '(refuse|charge) [RC]-[A-Z0-9]+' | awk '{print $2}' | sort -u)"
	for id in $ids; do
		copy="$dir/guard-spend.sh"
		sed -E "s/(refuse|charge) $id( |\$)/true $id\\2/g" "$self" >"$copy"
		if SELFTEST_FAILFAST=1 HOOK_ROOT="$HOOK_ROOT" bash "$copy" --self-test >/dev/null 2>&1; then
			survived=$((survived + 1))
			echo "  ✗ mutant SURVIVED: disabling $id fails no self-test case"
		else
			killed=$((killed + 1))
			echo "  ✓ disabling $id fails the self-test"
		fi
	done
	# Targeted mutants — see guard-destroy.sh's mutation_test for the `# @mut` marker convention.
	local names name lib="${self%/*}/lib/cmdline.sh"
	names="$(cat "$self" "$lib" | grep -oE '# @mut(-sub)? [a-z0-9-]+' | awk '{print $3}' | sort -u)"
	for name in $names; do
		cp "$self" "$dir/guard-spend.sh"
		cp "$lib" "$dir/lib/cmdline.sh"
		perl -i -pe 'BEGIN { $n = shift @ARGV }
			if ($next) { if (defined $sub && length $sub) { eval $sub } else { s/^(\s*)\S+/$1true/ } $next = 0 }
			if (/^\s*# \@mut(-sub)? \Q$n\E(?:\s+(.*))?$/) { $next = 1; $sub = $2 }' "$name" "$dir/guard-spend.sh" "$dir/lib/cmdline.sh"
		if cmp -s "$self" "$dir/guard-spend.sh" && cmp -s "$lib" "$dir/lib/cmdline.sh"; then
			survived=$((survived + 1))
			echo "  ✗ marker $name did not apply"
			continue
		fi
		if SELFTEST_FAILFAST=1 HOOK_ROOT="$HOOK_ROOT" bash "$dir/guard-spend.sh" --self-test >/dev/null 2>&1; then
			survived=$((survived + 1))
			echo "  ✗ mutant SURVIVED: disabling @$name fails no self-test case"
		else
			killed=$((killed + 1))
			echo "  ✓ disabling @$name fails the self-test"
		fi
	done
	echo "  ${killed} mutants killed, ${survived} survived"
	[ "$survived" -eq 0 ] && [ "$killed" -gt 0 ]
}

case "${1:-}" in
--self-test | --mutation-test)
	_s="$_self"
	case "$_s" in /*) ;; *) _s="$PWD/$_s" ;; esac
	# The repo whose workflows the table must cover: this file's own checkout.
	HOOK_ROOT="${HOOK_ROOT:-$(cd "${_s%/*}/../.." && pwd)}"
	if [ "$1" = --self-test ]; then self_test "$_s"; else mutation_test "$_s"; fi
	exit $?
	;;
--status)
	status
	exit 0
	;;
esac
main
