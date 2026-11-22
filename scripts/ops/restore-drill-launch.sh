#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The weekly restore drill's WORKFLOW side (BKP-L3, #7245): what .github/workflows/restore-drill.yml
# runs, one subcommand per step. The instance side is scripts/ops/restore-drill-ec2.sh.
#
#   restore-drill-launch.sh preflight
#   restore-drill-launch.sh launch
#   restore-drill-launch.sh wait       <instance-id>
#   restore-drill-launch.sh terminate  <instance-id>
#   restore-drill-launch.sh collect    <instance-id> <dest-dir>
#   restore-drill-launch.sh report     <outcome> [<record-file>]
#   restore-drill-launch.sh --self-test
#
# preflight  decides whether the drill is CONFIGURED: the three repository variables below set, well
#            formed, and the run on `main` (drill-launcher trusts that one OIDC subject). Unset is
#            not an error: it prints `configured=false` and the reason, so the weekly run is green
#            until the maintainer has applied infra/backup-account. A malformed value IS an error.
# launch     starts ONE instance from the launch template, overriding nothing (the role may not
#            override anything: ec2:IsLaunchTemplateResource). Prints `instance_id=`.
# wait       polls the instance until it has powered itself off (it does when the drill ends) or
#            DRILL_MAX_WAIT_MINUTES pass. Prints `ended=finished|timeout` and `state=`.
# terminate  the guard: terminates the instance unless it is already gone. The workflow runs it
#            whatever happened before. A no-op for an empty id. Exits non-zero only if an instance
#            may still be running, which must turn the run red.
# collect    downloads <evidence prefix><id>/result.json, then the record and log it names (each
#            name checked against the record pattern) into <dest-dir>. Prints `verdict=`,
#            `record=` and `log=`; `verdict=missing` when the instance left no result.
# report     writes the job summary, and keeps ONE issue titled "Restore drill failing": opened or
#            commented on when the outcome is not a pass, commented on and closed by the next pass.
#
# Outputs are `key=value` lines appended to $GITHUB_OUTPUT (stdout when unset).
#
# Environment
#   DRILL_ROLE_ARN            drill-launcher's ARN    (repository variable BACKUP_DRILL_LAUNCHER_ROLE_ARN)
#   DRILL_LAUNCH_TEMPLATE_ID  lt-…                    (repository variable BACKUP_DRILL_LAUNCH_TEMPLATE_ID)
#   DRILL_BUCKET              the backup bucket       (repository variable BACKUP_BUCKET)
#   AWS_REGION                default eu-central-1    (repository variable BACKUP_AWS_REGION)
#   DRILL_EVIDENCE_PREFIX     default evidence/ (infra/backup-account/main.tf evidence_prefix)
#   DRILL_MAX_WAIT_MINUTES    default 240             (repository variable BACKUP_DRILL_MAX_WAIT_MINUTES)
#   DRILL_POLL_SECONDS        default 60
#
# CREDENTIALS. drill-launcher's sessions last at most an hour (max_session_duration), and a drill can
# take longer. So no step holds one session: every `aws` call is made with a web identity token file
# that is refreshed from the job's OIDC endpoint just before the call, and the CLI exchanges it for a
# fresh session itself (AWS_ROLE_ARN + AWS_WEB_IDENTITY_TOKEN_FILE). The token lives in a 0600 file
# under RUNNER_TEMP and is never printed. Outside Actions (no ACTIONS_ID_TOKEN_REQUEST_URL) the
# ambient AWS credentials are used, which is what the self-test's fake `aws` relies on.
#
# Never add `set -x`: the token file is a credential.
#
# SC2016/SC2034: the self-test's assertions are single-quoted conditions that `check` evaluates.
# shellcheck disable=SC2016,SC2034

set -euo pipefail

ROLE_ARN_RE='^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$'
LAUNCH_TEMPLATE_RE='^lt-[0-9a-f]{8,17}$'
BUCKET_RE='^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
INSTANCE_ID_RE='^i-[0-9a-f]{8,17}$'
EVIDENCE_NAME_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}-restore-drill(-[0-9]{6})?\.(md|log)$'
ISSUE_TITLE="Restore drill failing"

REGION="${AWS_REGION:-eu-central-1}"
EVIDENCE_PREFIX="${DRILL_EVIDENCE_PREFIX:-evidence/}"
TOKEN_FILE=""

#######################################
# Prints a progress line on stderr.
#######################################
log() {
	printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

#######################################
# Prints an error on stderr and exits with the given code (default 1).
#######################################
die() {
	printf 'error: %s\n' "$1" >&2
	exit "${2:-1}"
}

#######################################
# Appends key=value to the step's outputs (stdout outside Actions).
#######################################
output() {
	printf '%s=%s\n' "$1" "$2" >>"${GITHUB_OUTPUT:-/dev/stdout}"
}

#######################################
# Refreshes the OIDC web identity token file, when running in Actions. The request's bearer token
# goes through a 0600 curl config file, not the command line.
#######################################
refresh_token() {
	[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || return 0
	[ -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ] || die "no OIDC request token: the job needs 'id-token: write'"
	local dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}" cfg resp
	TOKEN_FILE="$dir/restore-drill.oidc"
	cfg="$dir/restore-drill.oidc.curl"
	resp="$dir/restore-drill.oidc.json"
	(
		umask 077
		printf 'url = "%s&audience=sts.amazonaws.com"\nheader = "Authorization: bearer %s"\noutput = "%s"\n' \
			"$ACTIONS_ID_TOKEN_REQUEST_URL" "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$resp" >"$cfg"
	)
	curl -fsS --max-time 20 --retry 3 -K "$cfg" || { rm -f "$cfg" "$resp"; die "could not mint an OIDC token"; }
	rm -f "$cfg"
	(umask 077 && jq -r '.value // empty' "$resp" >"$TOKEN_FILE")
	rm -f "$resp"
	[ -s "$TOKEN_FILE" ] || die "the OIDC endpoint returned no token"
}

#######################################
# Runs the AWS CLI as drill-launcher, with a token minted just now (see CREDENTIALS above).
#######################################
aws_call() {
	refresh_token
	if [ -n "$TOKEN_FILE" ]; then
		AWS_ROLE_ARN="$DRILL_ROLE_ARN" AWS_WEB_IDENTITY_TOKEN_FILE="$TOKEN_FILE" \
			AWS_ROLE_SESSION_NAME="restore-drill-${GITHUB_RUN_ID:-local}" \
			AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" aws "$@"
	else
		AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" aws "$@"
	fi
}

#######################################
# Exits 64 unless the instance id argument is well formed.
#######################################
need_instance_id() {
	[[ "${1:-}" =~ $INSTANCE_ID_RE ]] || die "expected an instance id (i-…), got '${1:-nothing}'" 64
}

#######################################
# preflight: configured or not, and why. Pure apart from its outputs.
#######################################
cmd_preflight() {
	local missing=()
	[ -n "${DRILL_ROLE_ARN:-}" ] || missing+=(BACKUP_DRILL_LAUNCHER_ROLE_ARN)
	[ -n "${DRILL_LAUNCH_TEMPLATE_ID:-}" ] || missing+=(BACKUP_DRILL_LAUNCH_TEMPLATE_ID)
	[ -n "${DRILL_BUCKET:-}" ] || missing+=(BACKUP_BUCKET)
	if [ "${#missing[@]}" -gt 0 ]; then
		output configured false
		output reason "not configured: repository variable(s) ${missing[*]} unset (infra/backup-account outputs; see docs/ops/restore-runbook.md)"
		return 0
	fi
	[[ "$DRILL_ROLE_ARN" =~ $ROLE_ARN_RE ]] || die "BACKUP_DRILL_LAUNCHER_ROLE_ARN is not an IAM role ARN"
	[[ "$DRILL_LAUNCH_TEMPLATE_ID" =~ $LAUNCH_TEMPLATE_RE ]] || die "BACKUP_DRILL_LAUNCH_TEMPLATE_ID is not a launch template id (lt-…)"
	[[ "$DRILL_BUCKET" =~ $BUCKET_RE ]] || die "BACKUP_BUCKET is not a bucket name"
	[[ "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "BACKUP_AWS_REGION is not a region"
	[[ "$EVIDENCE_PREFIX" =~ ^[a-z0-9-]+/$ ]] || die "DRILL_EVIDENCE_PREFIX must end in /"
	# Below the job's timeout-minutes (300) with room for launch, collect and the PR: a job that times
	# out mid-wait would leave the instance to its own lifetime limit alone.
	local max="${DRILL_MAX_WAIT_MINUTES:-240}"
	[[ "$max" =~ ^[0-9]+$ ]] && [ "$max" -ge 30 ] && [ "$max" -le 270 ] ||
		die "BACKUP_DRILL_MAX_WAIT_MINUTES must be whole minutes from 30 to 270 (the job times out at 300)"
	if [ "${GITHUB_REF:-refs/heads/main}" != "refs/heads/main" ]; then
		output configured false
		output reason "not run: drill-launcher trusts only runs on main, and this run is on ${GITHUB_REF}"
		return 0
	fi
	output configured true
	output reason "configured"
}

#######################################
# launch: one instance from the template, nothing overridden.
#######################################
cmd_launch() {
	local id
	id="$(aws_call ec2 run-instances --launch-template "LaunchTemplateId=$DRILL_LAUNCH_TEMPLATE_ID" \
		--count 1 --query 'Instances[0].InstanceId' --output text)" || die "RunInstances failed (spot capacity, quota, or the role)"
	[[ "$id" =~ $INSTANCE_ID_RE ]] || die "RunInstances returned no instance id"
	log "launched $id"
	output instance_id "$id"
}

#######################################
# Prints an instance's state name, or `unknown` when it cannot be read.
#######################################
instance_state() {
	local s
	s="$(aws_call ec2 describe-instances --instance-ids "$1" \
		--query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || true)"
	case "$s" in pending | running | shutting-down | terminated | stopping | stopped) printf '%s' "$s" ;; *) printf 'unknown' ;; esac
}

#######################################
# wait: until the instance powers itself off, or the deadline.
#######################################
cmd_wait() {
	need_instance_id "${1:-}"
	local id="$1" max="${DRILL_MAX_WAIT_MINUTES:-240}" poll="${DRILL_POLL_SECONDS:-60}" deadline state
	deadline=$(($(date -u +%s) + max * 60))
	while :; do
		state="$(instance_state "$id")"
		case "$state" in
			shutting-down | terminated | stopping | stopped)
				log "$id is $state: the drill has ended"
				output ended finished
				output state "$state"
				return 0
				;;
		esac
		if [ "$(date -u +%s)" -ge "$deadline" ]; then
			log "$id still $state after ${max} minutes: giving up (the terminate guard runs next)"
			output ended timeout
			output state "$state"
			return 0
		fi
		sleep "$poll"
	done
}

#######################################
# terminate: whatever happened, leave no drill instance running.
#######################################
cmd_terminate() {
	[ -n "${1:-}" ] || { log "no instance was launched; nothing to terminate"; return 0; }
	need_instance_id "$1"
	local id="$1" state
	state="$(instance_state "$id")"
	case "$state" in
		terminated)
			log "$id is already terminated"
			output terminated already
			return 0
			;;
	esac
	log "$id is $state: terminating it"
	if aws_call ec2 terminate-instances --instance-ids "$id" >/dev/null; then
		output terminated now
		return 0
	fi
	output terminated failed
	die "could not terminate $id: it may still be running and holding restored data. Terminate it in the backup account now."
}

#######################################
# collect: the evidence the instance left, checked before it touches the work tree.
#######################################
cmd_collect() {
	need_instance_id "${1:-}"
	local id="$1" dest="${2:-}" tmp src record log_name verdict rid f
	[ -n "$dest" ] || die "collect needs a destination directory" 64
	tmp="$(mktemp -d)"
	src="s3://$DRILL_BUCKET/${EVIDENCE_PREFIX}${id}"
	if ! aws_call s3 cp --only-show-errors "$src/result.json" "$tmp/result.json" 2>/dev/null; then
		rm -rf "$tmp"
		log "no result.json under ${EVIDENCE_PREFIX}${id}/: the drill left no evidence"
		output verdict missing
		return 0
	fi
	rid="$(jq -r '.instanceId // empty' "$tmp/result.json" 2>/dev/null || true)"
	verdict="$(jq -r '.verdict // empty' "$tmp/result.json" 2>/dev/null || true)"
	record="$(jq -r '.record // empty' "$tmp/result.json" 2>/dev/null || true)"
	log_name="$(jq -r '.log // empty' "$tmp/result.json" 2>/dev/null || true)"
	[ "$rid" = "$id" ] || { rm -rf "$tmp"; die "result.json names instance '$rid', not $id"; }
	case "$verdict" in pass | fail) ;; *) rm -rf "$tmp"; die "result.json has no verdict" ;; esac
	mkdir -p "$dest"
	for f in "$record" "$log_name"; do
		[ -n "$f" ] || continue
		[[ "$f" =~ $EVIDENCE_NAME_RE ]] || { rm -rf "$tmp"; die "result.json names a file that is not a drill record: '$f'"; }
		aws_call s3 cp --only-show-errors "$src/$f" "$dest/$f" || { rm -rf "$tmp"; die "could not download $f"; }
	done
	rm -rf "$tmp"
	# A pass without its record cannot be committed as evidence; say so rather than open an empty PR.
	if [ "$verdict" = pass ] && { [ -z "$record" ] || [ ! -s "$dest/$record" ]; }; then
		verdict=fail
		log "result.json says pass but names no record; reported as a fail"
	fi
	log "verdict $verdict; record ${record:-none}; log ${log_name:-none}"
	output verdict "$verdict"
	output record "$record"
	output log "$log_name"
}

#######################################
# Prints the record's one-line outcome (its "- Outcome:" bullet), or nothing. Counts and steps only:
# the record never carries personal data.
#######################################
record_outcome() {
	[ -n "${1:-}" ] && [ -r "$1" ] || return 0
	sed -n 's/^- Outcome: //p' "$1" | head -n 1
}

#######################################
# report: the job summary and the one tracking issue.
#   outcome: pass · fail · missing · timeout · launch-failed · not-configured
#######################################
cmd_report() {
	local outcome="${1:-}" record="${2:-}" note run_url summary="${GITHUB_STEP_SUMMARY:-/dev/stderr}" n body
	case "$outcome" in pass | fail | missing | timeout | launch-failed | not-configured) ;; *) die "unknown outcome '$outcome'" 64 ;; esac
	note="$(record_outcome "$record")"
	run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"
	{
		printf '## Restore drill: %s\n\n' "$outcome"
		case "$outcome" in
			pass) printf 'The newest backup was restored, its tombstones replayed, and the console answered healthy. The record is in an evidence PR into `dev`.\n' ;;
			fail) printf 'The drill ran and failed. The record says why; the instance is terminated.\n' ;;
			missing) printf 'The instance ended without leaving a result under the evidence prefix. Read its console output in the backup account (EC2, Get system log) before it ages out.\n' ;;
			timeout) printf 'The instance had not finished within the wait. The terminate guard ended it.\n' ;;
			launch-failed) printf 'No instance was started (spot capacity, quota, or the role). Nothing ran, and nothing is left running.\n' ;;
			not-configured) printf '%s\n' "${DRILL_REASON:-The drill is not configured.}" ;;
		esac
		[ -z "$note" ] || printf '\nRecord outcome: %s\n' "$note"
	} >>"$summary"

	# Not configured is not a failure of the drill, and must not open an issue every week.
	[ "$outcome" != not-configured ] || return 0
	command -v gh >/dev/null 2>&1 || { log "gh not found; no issue updated"; return 0; }

	n="$(gh issue list --state open --search "\"$ISSUE_TITLE\" in:title" --json number,title \
		--jq "map(select(.title == \"$ISSUE_TITLE\")) | .[0].number // empty" 2>/dev/null || true)"
	if [ "$outcome" = pass ]; then
		[ -z "$n" ] || gh issue close "$n" --comment "The restore drill passed again in $run_url." >/dev/null
		return 0
	fi
	body="The weekly restore drill (\`.github/workflows/restore-drill.yml\`) did not pass.

- Outcome: **$outcome**${note:+
- Record: $note}
- Run: $run_url

Runbook: \`docs/ops/restore-runbook.md\`, \"The restore drill\". This issue is closed by the next passing drill."
	if [ -n "$n" ]; then
		gh issue comment "$n" --body "$body" >/dev/null
	else
		gh issue create --title "$ISSUE_TITLE" --body "$body" >/dev/null
	fi
}

#######################################
# Hermetic self-test: fake aws, curl and gh on PATH, each answering from scenario files. Every
# assertion feeds the exit code.
#######################################
self_test() {
	local fails=0 tmp out rc
	tmp="$(mktemp -d)"
	SELF_TEST_DIR="$tmp"
	trap 'rm -rf "$SELF_TEST_DIR"' EXIT
	mkdir -p "$tmp/bin"

	# Fake aws: run-instances, describe-instances (one state per call from a queue), terminate,
	# s3 cp from a fake bucket directory. Every call is logged with the role env it saw.
	cat >"$tmp/bin/aws" <<-'SH'
		#!/usr/bin/env bash
		echo "${AWS_ROLE_ARN:-ambient} $*" >>"$FAKE/calls"
		case "$1 $2" in
		  "ec2 run-instances") [ -e "$FAKE/run-fail" ] && exit 254; cat "$FAKE/run-out"; exit 0 ;;
		  "ec2 describe-instances")
		    s="$(head -n 1 "$FAKE/states")"; [ "$(wc -l <"$FAKE/states")" -gt 1 ] && sed -i.bak 1d "$FAKE/states"
		    printf '%s\n' "$s"; exit 0 ;;
		  "ec2 terminate-instances") [ -e "$FAKE/terminate-fail" ] && exit 254; echo terminated >>"$FAKE/terminated"; exit 0 ;;
		  "s3 cp")
		    src="" dst=""
		    for a in "${@:3}"; do case "$a" in --*) ;; *) if [ -z "$src" ]; then src="$a"; else dst="$a"; fi ;; esac; done
		    key="${src#s3://}"; [ -f "$FAKE/bucket/$key" ] || exit 1
		    cp "$FAKE/bucket/$key" "$dst"; exit 0 ;;
		esac
		echo "fake aws: unexpected $*" >&2; exit 99
	SH
	cat >"$tmp/bin/curl" <<-'SH'
		#!/usr/bin/env bash
		cfg=""; while [ $# -gt 0 ]; do [ "$1" = -K ] && cfg="$2"; shift; done
		cp "$cfg" "$FAKE/last-oidc-config"
		out="$(sed -n 's/^output = "\(.*\)"$/\1/p' "$cfg")"
		printf '{"value":"OIDC-JWT-NEVER-PRINT"}' >"$out"
	SH
	cat >"$tmp/bin/gh" <<-'SH'
		#!/usr/bin/env bash
		echo "gh $*" >>"$FAKE/gh"
		case "$1 $2" in
		  "issue list") cat "$FAKE/open-issue" 2>/dev/null; exit 0 ;;
		esac
		exit 0
	SH
	chmod +x "$tmp/bin/"*

	scenario() { # scenario [flag-files…]
		rm -rf "$tmp/fake" "$tmp/out" "$tmp/dest"
		mkdir -p "$tmp/fake/bucket/alethia-prod-backup-123456789012/evidence/i-0123456789abcdef0"
		printf 'i-0123456789abcdef0\n' >"$tmp/fake/run-out"
		printf 'running\n' >"$tmp/fake/states"
		local f
		for f in "$@"; do : >"$tmp/fake/$f"; done
	}
	go() { # go [ENV=VALUE…] -- <args…>
		local envs=()
		while [ "$1" != -- ]; do envs+=("$1"); shift; done
		shift
		rc=0
		: >"$tmp/out"
		out="$(env FAKE="$tmp/fake" PATH="$tmp/bin:$PATH" GITHUB_OUTPUT="$tmp/out" GITHUB_STEP_SUMMARY="$tmp/summary" \
			DRILL_ROLE_ARN="arn:aws:iam::123456789012:role/drill-launcher" DRILL_LAUNCH_TEMPLATE_ID="lt-0123456789abcdef0" \
			DRILL_BUCKET=alethia-prod-backup-123456789012 GITHUB_REF=refs/heads/main DRILL_POLL_SECONDS=0 \
			${envs[@]+"${envs[@]}"} bash "${BASH_SOURCE[0]}" "$@" 2>&1)" || rc=$?
	}
	outv() { sed -n "s/^$1=//p" "$tmp/out" | tail -n 1; }
	check() { # check <name> <condition, as a string for eval>
		if eval "$2"; then printf 'ok    %s\n' "$1"; else
			printf 'FAIL  %s (rc %s)\n%s\n%s\n' "$1" "$rc" "$(sed 's/^/      out: /' "$tmp/out" 2>/dev/null)" "$(printf '%s' "$out" | sed 's/^/      /')"
			fails=$((fails + 1))
		fi
	}

	# preflight
	scenario
	go DRILL_ROLE_ARN= DRILL_BUCKET= -- preflight
	check "unset variables are 'not configured', not an error" '[ "$rc" = 0 ] && [ "$(outv configured)" = false ] && [[ "$(outv reason)" == *BACKUP_DRILL_LAUNCHER_ROLE_ARN*BACKUP_BUCKET* ]]'
	go -- preflight
	check "all three set on main is configured" '[ "$rc" = 0 ] && [ "$(outv configured)" = true ]'
	go GITHUB_REF=refs/heads/feat/x -- preflight
	check "a run off main is not run (the role trusts only main)" '[ "$rc" = 0 ] && [ "$(outv configured)" = false ] && [[ "$(outv reason)" == *"only runs on main"* ]]'
	go DRILL_ROLE_ARN=drill-launcher -- preflight
	check "a malformed role ARN is an error" '[ "$rc" = 1 ] && [[ "$out" == *"not an IAM role ARN"* ]]'
	go DRILL_LAUNCH_TEMPLATE_ID=alethia-restore-drill -- preflight
	check "a launch template NAME instead of its id is an error" '[ "$rc" = 1 ] && [[ "$out" == *"lt-"* ]]'
	go DRILL_MAX_WAIT_MINUTES=4h -- preflight
	check "a non-numeric wait is an error" '[ "$rc" = 1 ]'
	go DRILL_MAX_WAIT_MINUTES=360 -- preflight
	check "a wait past the job timeout is an error" '[ "$rc" = 1 ] && [[ "$out" == *"times out at 300"* ]]'

	# launch
	scenario
	go -- launch
	check "launch prints the instance id" '[ "$rc" = 0 ] && [ "$(outv instance_id)" = i-0123456789abcdef0 ]'
	check "launch names the template and overrides nothing else" 'grep -q "run-instances --launch-template LaunchTemplateId=lt-0123456789abcdef0 --count 1 --query" "$tmp/fake/calls" && ! grep -Eq -- "--(image-id|instance-type|user-data|iam-instance-profile|tag-specifications)" "$tmp/fake/calls"'
	scenario run-fail
	go -- launch
	check "a refused launch fails and prints no id" '[ "$rc" = 1 ] && [ -z "$(outv instance_id)" ]'
	scenario
	printf 'None\n' >"$tmp/fake/run-out"
	go -- launch
	check "a launch that returns no id fails" '[ "$rc" = 1 ]'

	# wait
	scenario
	printf 'pending\nrunning\nrunning\nshutting-down\n' >"$tmp/fake/states"
	go -- wait i-0123456789abcdef0
	check "wait ends when the instance powers itself off" '[ "$rc" = 0 ] && [ "$(outv ended)" = finished ] && [ "$(outv state)" = shutting-down ]'
	scenario
	go DRILL_MAX_WAIT_MINUTES=0 -- wait i-0123456789abcdef0
	check "wait gives up at the deadline and says so" '[ "$rc" = 0 ] && [ "$(outv ended)" = timeout ] && [ "$(outv state)" = running ]'
	go -- wait "i-0123; rm -rf /"
	check "wait refuses a malformed instance id" '[ "$rc" = 64 ]'

	# terminate
	scenario
	go -- terminate i-0123456789abcdef0
	check "the guard terminates a running instance" '[ "$rc" = 0 ] && [ -s "$tmp/fake/terminated" ] && [ "$(outv terminated)" = now ]'
	scenario
	printf 'terminated\n' >"$tmp/fake/states"
	go -- terminate i-0123456789abcdef0
	check "the guard leaves an already-terminated instance alone" '[ "$rc" = 0 ] && [ ! -e "$tmp/fake/terminated" ] && [ "$(outv terminated)" = already ]'
	scenario
	go -- terminate ""
	check "the guard is a no-op when nothing was launched" '[ "$rc" = 0 ] && [ ! -e "$tmp/fake/calls" ]'
	scenario terminate-fail
	go -- terminate i-0123456789abcdef0
	check "a failed terminate turns the step red" '[ "$rc" = 1 ] && [ "$(outv terminated)" = failed ]'

	# collect
	local ev="$tmp/fake/bucket/alethia-prod-backup-123456789012/evidence/i-0123456789abcdef0"
	scenario
	jq -n '{schemaVersion:1, instanceId:"i-0123456789abcdef0", verdict:"pass", exitCode:0, record:"2026-12-07-restore-drill.md", log:"2026-12-07-restore-drill.log"}' >"$ev/result.json"
	printf -- '---\nverdict: pass\n---\n- Outcome: restored, replayed and serving in 812s\n' >"$ev/2026-12-07-restore-drill.md"
	echo log >"$ev/2026-12-07-restore-drill.log"
	go -- collect i-0123456789abcdef0 "$tmp/dest"
	check "collect downloads the record and log a passing result names" '[ "$rc" = 0 ] && [ "$(outv verdict)" = pass ] && [ -s "$tmp/dest/2026-12-07-restore-drill.md" ] && [ -s "$tmp/dest/2026-12-07-restore-drill.log" ]'
	scenario
	go -- collect i-0123456789abcdef0 "$tmp/dest"
	check "no result.json is verdict=missing, not an error" '[ "$rc" = 0 ] && [ "$(outv verdict)" = missing ]'
	scenario
	jq -n '{instanceId:"i-0123456789abcdef0", verdict:"pass", record:"../../.github/workflows/x.md", log:""}' >"$ev/result.json"
	go -- collect i-0123456789abcdef0 "$tmp/dest"
	check "a result naming a path outside the record pattern is refused" '[ "$rc" = 1 ] && [ ! -e "$tmp/dest/x.md" ]'
	scenario
	jq -n '{instanceId:"i-0fffffffffffffff0", verdict:"pass", record:"", log:""}' >"$ev/result.json"
	go -- collect i-0123456789abcdef0 "$tmp/dest"
	check "a result for another instance is refused" '[ "$rc" = 1 ]'
	scenario
	jq -n '{instanceId:"i-0123456789abcdef0", verdict:"pass", record:"", log:""}' >"$ev/result.json"
	go -- collect i-0123456789abcdef0 "$tmp/dest"
	check "a pass with no record is reported as a fail" '[ "$rc" = 0 ] && [ "$(outv verdict)" = fail ]'

	# credentials: inside Actions every call carries the role and a fresh token file; nothing leaks.
	scenario
	go ACTIONS_ID_TOKEN_REQUEST_URL="https://oidc.invalid/token?x=1" ACTIONS_ID_TOKEN_REQUEST_TOKEN=REQ-NEVER-PRINT RUNNER_TEMP="$tmp" -- launch
	check "in Actions the CLI assumes drill-launcher by web identity" '[ "$rc" = 0 ] && grep -q "^arn:aws:iam::123456789012:role/drill-launcher ec2 run-instances" "$tmp/fake/calls"'
	check "the OIDC request asks for the STS audience, with the bearer in the config file" 'grep -q "audience=sts.amazonaws.com" "$tmp/fake/last-oidc-config" && grep -q "REQ-NEVER-PRINT" "$tmp/fake/last-oidc-config"'
	check "neither token reaches the output" '[[ "$out" != *NEVER-PRINT* ]] && ! grep -q NEVER-PRINT "$tmp/out"'
	check "the request config is removed after use" '[ ! -e "$tmp/restore-drill.oidc.curl" ] && [ ! -e "$tmp/restore-drill.oidc.json" ]'
	go ACTIONS_ID_TOKEN_REQUEST_URL="https://oidc.invalid/token?x=1" ACTIONS_ID_TOKEN_REQUEST_TOKEN= -- launch
	check "a job without id-token: write fails with that reason" '[ "$rc" = 1 ] && [[ "$out" == *"id-token: write"* ]]'

	# report
	scenario
	rm -f "$tmp/summary"
	go -- report fail "$ev/../../../../../nonexistent"
	check "a failed drill opens the tracking issue" '[ "$rc" = 0 ] && grep -q "gh issue create --title Restore drill failing" "$tmp/fake/gh"'
	scenario
	printf '7301\n' >"$tmp/fake/open-issue"
	go -- report timeout
	check "a second failure comments on the open issue instead of opening another" '[ "$rc" = 0 ] && grep -q "gh issue comment 7301" "$tmp/fake/gh" && ! grep -q "issue create" "$tmp/fake/gh"'
	scenario
	printf '7301\n' >"$tmp/fake/open-issue"
	go -- report pass
	check "a pass closes the open issue" '[ "$rc" = 0 ] && grep -q "gh issue close 7301" "$tmp/fake/gh"'
	scenario
	go -- report pass
	check "a pass with no open issue touches nothing" '[ "$rc" = 0 ] && ! grep -Eq "issue (create|comment|close)" "$tmp/fake/gh"'
	scenario
	rm -f "$tmp/summary"
	go DRILL_REASON="not configured: repository variable(s) BACKUP_BUCKET unset" -- report not-configured
	check "not configured writes the reason to the summary and opens no issue" '[ "$rc" = 0 ] && grep -q "BACKUP_BUCKET unset" "$tmp/summary" && [ ! -e "$tmp/fake/gh" ]'
	scenario
	printf -- '- Outcome: failed at step '"'"'restore'"'"' (exit 1)\n' >"$tmp/rec.md"
	go -- report fail "$tmp/rec.md"
	check "the issue quotes the record's outcome line" 'grep -q "failed at step" "$tmp/fake/gh"'
	go -- report exploded
	check "an unknown outcome is refused" '[ "$rc" = 64 ]'

	if [ "$fails" -ne 0 ]; then
		printf '\n%s self-test assertion(s) failed\n' "$fails"
		return 1
	fi
	printf '\nall self-test assertions passed\n'
}

#######################################
# Entry point.
#######################################
main() {
	local cmd="${1:-}"
	[ $# -eq 0 ] || shift
	case "$cmd" in
		preflight) cmd_preflight ;;
		launch) cmd_launch ;;
		wait) cmd_wait "$@" ;;
		terminate) cmd_terminate "$@" ;;
		collect) cmd_collect "$@" ;;
		report) cmd_report "$@" ;;
		--self-test) self_test ;;
		-h | --help) sed -n '5,50p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
		*) die "usage: restore-drill-launch.sh preflight|launch|wait|terminate|collect|report|--self-test (see --help)" 64 ;;
	esac
}

main "$@"
