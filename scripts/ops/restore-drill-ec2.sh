#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The weekly restore drill's entrypoint ON THE DRILL INSTANCE (BKP-L3, #7245). The launch template's
# user-data (infra/backup-account/drill-user-data.sh.tftpl) runs exactly this, as root, from a fresh
# clone of the protected branch:
#
#   restore-drill-ec2.sh --env-file /etc/alethia/drill.env
#   restore-drill-ec2.sh --self-test
#
# It is the glue between the instance and scripts/ops/restore-drill.sh, which does the restore:
#
#   1  reads the non-secret settings user-data wrote (bucket, region, prefixes, the secret's NAME)
#   2  asks the instance metadata service (IMDSv2) for this instance's id and its role's temporary
#      credentials. Nothing is passed in from the workflow, so no key ever crosses its log.
#   3  fetches the drill's age identity from Secrets Manager ITSELF (SigV4 via curl), into a 0600
#      file inside a 0700 directory. Never printed, never on a command line, removed on exit.
#   4  runs restore-drill.sh --target drill --execute, with the clock started at boot so the record's
#      duration includes the instance's own start-up, and --observer agent
#   5  uploads the record, its log and a small result.json to <evidence prefix><instance id>/ in the
#      backup bucket. result.json goes LAST: it is the marker that the evidence is complete, and the
#      workflow (scripts/ops/restore-drill-launch.sh collect) reads only what it names.
#
# Its exit code is restore-drill.sh's. The user-data powers the instance off when this returns,
# whatever it returns, and powering off terminates it.
#
# Settings read from --env-file (written by user-data; none of them is a secret):
#   BACKUP_S3_PROVIDER BACKUP_S3_REGION BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_PREFIX
#   DRILL_EVIDENCE_PREFIX       e.g. evidence/
#   DRILL_AGE_IDENTITY_SECRET   the Secrets Manager secret NAME (the value is the age identity file)
#   BACKUP_S3_SSE_KMS_KEY_ID    optional; default: the alias ARN of alias/alethia-prod-backup in this
#                               account and region (infra/backup-account/main.tf kms_alias_name)
#
# Never add `set -x`: this script holds a decryption key and temporary cloud credentials.
#
# SC2016/SC2034: the self-test's assertions are single-quoted conditions that `check` evaluates, so
# the variables they read expand there, not where they are written.
# shellcheck disable=SC2016,SC2034

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../deploy/prod/backup/lib.sh source-path=SCRIPTDIR
. "$REPO/deploy/prod/backup/lib.sh"

# Test seams: the metadata service, the Secrets Manager endpoint and the drill itself.
IMDS_URL="${DRILL_IMDS_URL:-http://169.254.169.254}"
DRILL_SCRIPT="${DRILL_RESTORE_SCRIPT:-$HERE/restore-drill.sh}"
KMS_ALIAS_NAME="alias/alethia-prod-backup"
EVIDENCE_NAME_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}-restore-drill(-[0-9]{6})?\.(md|log)$'
INSTANCE_ID_RE='^i-[0-9a-f]{8,17}$'
AGE_IDENTITY_LINE_RE='^AGE-SECRET-KEY-1[0-9A-Z]+$'

ENV_FILE=""
WORK=""
IMDS_TOKEN=""
INSTANCE_ID=""
ACCOUNT_ID=""
REGION=""
SECRETS_ENDPOINT=""

#######################################
# Prints usage (the header comment).
#######################################
usage() {
	sed -n '5,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

#######################################
# Reads one setting: the environment wins over the env file, as in restore-drill.sh.
#######################################
setting() {
	local k="$1"
	if [ -n "${!k:-}" ]; then printf '%s' "${!k}"; else env_file_value "$ENV_FILE" "$k"; fi
}

#######################################
# Opens the IMDSv2 session: its token is kept in a variable, never written out. Called directly, not
# in a command substitution, so the token survives for every later imds_get.
#######################################
imds_init() {
	IMDS_TOKEN="$(curl -fsS --max-time 5 --retry 3 -X PUT "$IMDS_URL/latest/api/token" \
		-H 'X-aws-ec2-metadata-token-ttl-seconds: 21600')" || die "the instance metadata service did not answer (IMDSv2)"
	[ -n "$IMDS_TOKEN" ] || die "the instance metadata service returned no session token"
}

#######################################
# One IMDSv2 GET, inside the session imds_init opened.
#######################################
imds_get() {
	[ -n "$IMDS_TOKEN" ] || die "imds_get before imds_init"
	curl -fsS --max-time 5 --retry 3 -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" "$IMDS_URL/latest/$1"
}

#######################################
# Sets INSTANCE_ID, ACCOUNT_ID and REGION from the instance identity document.
#######################################
load_identity() {
	local doc
	doc="$(imds_get dynamic/instance-identity/document)" || die "could not read the instance identity document"
	INSTANCE_ID="$(printf '%s' "$doc" | jq -r '.instanceId // empty')"
	ACCOUNT_ID="$(printf '%s' "$doc" | jq -r '.accountId // empty')"
	REGION="$(printf '%s' "$doc" | jq -r '.region // empty')"
	[[ "$INSTANCE_ID" =~ $INSTANCE_ID_RE ]] || die "the identity document names no instance id"
	[[ "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || die "the identity document names no account id"
	[[ "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "the identity document names no region"
}

#######################################
# Exports the instance role's CURRENT temporary credentials as BACKUP_S3_* (lib.sh hands them to
# rclone through a 0600 env file). Called again before the evidence upload, because the drill can
# outlast the set it started with. Prints nothing.
#######################################
load_instance_credentials() {
	local role json
	role="$(imds_get meta-data/iam/security-credentials/ | head -n 1)" || die "this instance has no role (instance profile)"
	[[ "$role" =~ ^[A-Za-z0-9+=,.@_-]+$ ]] || die "the metadata service named no usable role"
	json="$(imds_get "meta-data/iam/security-credentials/$role")" || die "could not read the role's credentials"
	BACKUP_S3_ACCESS_KEY_ID="$(printf '%s' "$json" | jq -r '.AccessKeyId // empty')"
	BACKUP_S3_SECRET_ACCESS_KEY="$(printf '%s' "$json" | jq -r '.SecretAccessKey // empty')"
	BACKUP_S3_SESSION_TOKEN="$(printf '%s' "$json" | jq -r '.Token // empty')"
	export BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY BACKUP_S3_SESSION_TOKEN
	require_env BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY BACKUP_S3_SESSION_TOKEN
}

#######################################
# Fetches the drill's age identity into FILE (0600). Secrets Manager's GetSecretValue is a signed
# JSON POST; curl signs it (--aws-sigv4). Every credential goes through a 0600 curl config file, so
# none of them is ever an argument a process listing could show, and the response is written to a
# file, never to stdout. Fails, without saying anything about the value, unless the result holds an
# age identity line.
#######################################
fetch_identity() {
	local secret="$1" out="$2" cfg="$WORK/secretsmanager.curl" resp="$WORK/secretsmanager.json"
	[[ "$secret" =~ ^[A-Za-z0-9/_+=.@-]+$ ]] || die "DRILL_AGE_IDENTITY_SECRET is not a secret name"
	(
		umask 077
		{
			printf 'url = "%s/"\n' "$SECRETS_ENDPOINT"
			printf 'aws-sigv4 = "aws:amz:%s:secretsmanager"\n' "$REGION"
			printf 'user = "%s:%s"\n' "$BACKUP_S3_ACCESS_KEY_ID" "$BACKUP_S3_SECRET_ACCESS_KEY"
			printf 'header = "X-Amz-Security-Token: %s"\n' "$BACKUP_S3_SESSION_TOKEN"
			printf 'header = "X-Amz-Target: secretsmanager.GetSecretValue"\n'
			printf 'header = "Content-Type: application/x-amz-json-1.1"\n'
			printf 'data = "{\\"SecretId\\":\\"%s\\"}"\n' "$secret"
			printf 'output = "%s"\n' "$resp"
		} >"$cfg"
	)
	curl -fsS --max-time 30 --retry 3 -K "$cfg" || { rm -f "$cfg" "$resp"; die "Secrets Manager refused or did not answer for $secret"; }
	rm -f "$cfg"
	(umask 077 && jq -r '.SecretString // empty' "$resp" >"$out")
	rm -f "$resp"
	chmod 600 "$out"
	grep -Eq "$AGE_IDENTITY_LINE_RE" "$out" || { rm -f "$out"; die "the secret $secret holds no age identity (expected the file age-keygen writes)"; }
}

#######################################
# Prints the epoch second this instance booted, from the kernel's uptime.
#######################################
boot_epoch() {
	local up
	up="$(cut -d. -f1 /proc/uptime 2>/dev/null || true)"
	[[ "$up" =~ ^[0-9]+$ ]] || { date -u +%s; return; }
	printf '%s' "$(($(date -u +%s) - up))"
}

#######################################
# Prints the evidence files the drill wrote: the untracked records and logs under
# docs/beta/evidence/b7/ of the checkout it ran in. Names that do not look like a record are ignored.
#######################################
evidence_files() {
	local dir="$1/docs/beta/evidence/b7" f
	[ -d "$dir" ] || return 0
	for f in "$dir"/*; do
		[ -f "$f" ] || continue
		[[ "$(basename "$f")" =~ $EVIDENCE_NAME_RE ]] || continue
		if git -C "$1" ls-files --error-unmatch "${f#"$1"/}" >/dev/null 2>&1; then continue; fi
		printf '%s\n' "$f"
	done
}

#######################################
# Writes result.json: what the workflow needs to decide and to name the files. No secret, no data.
#   write_result <out> <exit code> <started epoch> <file…>
#######################################
write_result() {
	local out="$1" rc="$2" started="$3" record="" log_file="" f verdict
	shift 3
	for f in "$@"; do
		case "$f" in *.md) record="$(basename "$f")" ;; *.log) log_file="$(basename "$f")" ;; esac
	done
	verdict="fail"
	[ "$rc" -eq 0 ] && [ -n "$record" ] && verdict="pass"
	jq -n \
		--arg instanceId "$INSTANCE_ID" --arg verdict "$verdict" --argjson exitCode "$rc" \
		--arg record "$record" --arg log "$log_file" \
		--arg startedAt "$(iso_of_epoch "$started")" --arg finishedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		--arg commit "$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)" \
		'{schemaVersion: 1, instanceId: $instanceId, verdict: $verdict, exitCode: $exitCode,
		  record: $record, log: $log, startedAt: $startedAt, finishedAt: $finishedAt, drillCommit: $commit}' >"$out"
}

#######################################
# Prints the RFC 3339 UTC form of epoch seconds, on GNU or BSD date.
#######################################
iso_of_epoch() {
	date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ
}

#######################################
# Uploads files to <bucket>/<evidence prefix><instance id>/, in the order given. Bucket mode (every
# upload multipart, with Content-MD5 per part) because the bucket has Object Lock; SSE-KMS named
# explicitly so rclone does not read the ETag as an MD5 (lib.sh offbox_env_file). The drill role may
# only PUT here, so rclone is told not to HEAD the destination before or after.
#######################################
upload_evidence() {
	local prefix="$1" f envf
	shift
	envf="$(BACKUP_RETENTION=bucket offbox_env_file "$WORK")"
	for f in "$@"; do
		rclone_run - "$envf" "$(dirname "$f")" copyto "/work/$(basename "$f")" \
			"OFFBOX:$BACKUP_S3_BUCKET/${prefix}${INSTANCE_ID}/$(basename "$f")" \
			--no-check-dest --s3-no-head || return 1
	done
	rm -f "$envf"
}

#######################################
# The entrypoint proper.
#######################################
run() {
	local secret evidence_prefix started rc=0 files=() f out
	require_cmd curl jq docker age git
	[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE (pass --env-file)" 64
	WORK="$(secret_dir "${BACKUP_WORKDIR:-/var/tmp}")"
	trap 'rm -rf "$WORK"' EXIT

	BACKUP_S3_PROVIDER="$(setting BACKUP_S3_PROVIDER)"
	BACKUP_S3_REGION="$(setting BACKUP_S3_REGION)"
	BACKUP_S3_ENDPOINT="$(setting BACKUP_S3_ENDPOINT)"
	BACKUP_S3_BUCKET="$(setting BACKUP_S3_BUCKET)"
	BACKUP_PREFIX="$(setting BACKUP_PREFIX)"
	evidence_prefix="$(setting DRILL_EVIDENCE_PREFIX)"
	secret="$(setting DRILL_AGE_IDENTITY_SECRET)"
	export BACKUP_S3_PROVIDER BACKUP_S3_REGION BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_PREFIX
	require_env BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_REGION
	[ -n "$secret" ] || die "DRILL_AGE_IDENTITY_SECRET is unset in $ENV_FILE"
	[[ "$evidence_prefix" =~ ^[a-z0-9-]+/$ ]] || die "DRILL_EVIDENCE_PREFIX must be a prefix ending in / (got '$evidence_prefix')"

	started="$(boot_epoch)"
	imds_init
	load_identity
	[ "$REGION" = "$BACKUP_S3_REGION" ] || die "the instance runs in $REGION but the bucket is in $BACKUP_S3_REGION"
	SECRETS_ENDPOINT="${DRILL_SECRETS_ENDPOINT:-https://secretsmanager.$REGION.amazonaws.com}"
	BACKUP_S3_SSE_KMS_KEY_ID="$(setting BACKUP_S3_SSE_KMS_KEY_ID)"
	BACKUP_S3_SSE_KMS_KEY_ID="${BACKUP_S3_SSE_KMS_KEY_ID:-arn:aws:kms:$REGION:$ACCOUNT_ID:$KMS_ALIAS_NAME}"
	export BACKUP_S3_SSE_KMS_KEY_ID
	log "restore drill on $INSTANCE_ID ($REGION), clock started at boot $(iso_of_epoch "$started")"

	load_instance_credentials
	fetch_identity "$secret" "$WORK/drill.agekey"
	log "drill identity fetched from Secrets Manager ($secret)"

	"$DRILL_SCRIPT" --target drill --execute --env-file "$ENV_FILE" \
		--age-identity "$WORK/drill.agekey" --started-at "$started" --observer agent || rc=$?
	rm -f "$WORK/drill.agekey"
	log "restore-drill.sh finished with exit code $rc"

	while IFS= read -r f; do files+=("$f"); done < <(evidence_files "$REPO")
	out="$WORK/result.json"
	write_result "$out" "$rc" "$started" ${files[@]+"${files[@]}"}

	load_instance_credentials
	if upload_evidence "$evidence_prefix" ${files[@]+"${files[@]}"} "$out"; then
		log "evidence uploaded to ${evidence_prefix}${INSTANCE_ID}/ (${#files[@]} file(s) + result.json)"
	else
		log "evidence upload FAILED; the workflow will report the drill as having left no evidence"
		[ "$rc" -ne 0 ] || rc=1
	fi
	return "$rc"
}

#######################################
# Hermetic self-test: a fake IMDS, Secrets Manager, docker and drill, all on PATH. Every assertion
# feeds the exit code, and every check that a secret did NOT leak reads the captured output.
#######################################
self_test() {
	local fails=0 tmp
	tmp="$(secret_dir)"
	WORK="$tmp"
	trap 'rm -rf "$WORK"' EXIT
	mkdir -p "$tmp/bin" "$tmp/repo/scripts/ops" "$tmp/repo/deploy/prod/backup"
	cp "$REPO/deploy/prod/backup/lib.sh" "$tmp/repo/deploy/prod/backup/lib.sh"
	cp "${BASH_SOURCE[0]}" "$tmp/repo/scripts/ops/restore-drill-ec2.sh"
	git -C "$tmp/repo" init -q && git -C "$tmp/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

	local secret_key="SK-NEVER-PRINT-$$" session="ST-NEVER-PRINT-$$" age_secret="AGE-SECRET-KEY-1SELFTESTNEVERPRINTQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ"

	# Fake curl: answers IMDS paths and the Secrets Manager config-file call from scenario files.
	cat >"$tmp/bin/curl" <<-'SH'
		#!/usr/bin/env bash
		cfg="" url="" method=GET
		while [ $# -gt 0 ]; do
		  case "$1" in
		    -K) cfg="$2"; shift 2 ;;
		    -X) method="$2"; shift 2 ;;
		    -H|--max-time|--retry) shift 2 ;;
		    -*) shift ;;
		    *) url="$1"; shift ;;
		  esac
		done
		if [ -n "$cfg" ]; then
		  cp "$cfg" "$FAKE/last-curl-config"
		  [ -e "$FAKE/sm-fail" ] && exit 22
		  out="$(sed -n 's/^output = "\(.*\)"$/\1/p' "$cfg")"
		  cp "$FAKE/sm-response" "$out"; exit 0
		fi
		case "$method $url" in
		  "PUT "*/latest/api/token) echo put >>"$FAKE/imds-puts"; printf 'imds-token' ;;
		  *instance-identity/document) cat "$FAKE/identity" ;;
		  *security-credentials/) printf 'restore-drill\n' ;;
		  *security-credentials/restore-drill) cat "$FAKE/creds" ;;
		  *) echo "fake curl: unexpected $method $url" >&2; exit 22 ;;
		esac
	SH
	# Fake docker: records rclone uploads (the destination path) and fails when told to.
	cat >"$tmp/bin/docker" <<-'SH'
		#!/usr/bin/env bash
		for a in "$@"; do case "$a" in OFFBOX:*) echo "$a" >>"$FAKE/uploads" ;; esac; done
		[ -e "$FAKE/upload-fail" ] && exit 1
		exit 0
	SH
	# Fake drill: records its arguments, checks the identity file it was given, writes evidence.
	cat >"$tmp/bin/fake-drill" <<-'SH'
		#!/usr/bin/env bash
		printf '%s\n' "$@" >"$FAKE/drill-args"
		id=""; while [ $# -gt 0 ]; do [ "$1" = --age-identity ] && id="$2"; shift; done
		mode="$(stat -c %a "$id" 2>/dev/null || stat -f %Lp "$id")"
		echo "$mode" >"$FAKE/identity-mode"
		grep -q '^AGE-SECRET-KEY-1' "$id" && echo yes >"$FAKE/identity-ok"
		mkdir -p "$REPO_UNDER_TEST/docs/beta/evidence/b7"
		if [ ! -e "$FAKE/drill-fail" ]; then
		  echo rec >"$REPO_UNDER_TEST/docs/beta/evidence/b7/2026-12-07-restore-drill.md"
		  echo log >"$REPO_UNDER_TEST/docs/beta/evidence/b7/2026-12-07-restore-drill.log"
		  echo junk >"$REPO_UNDER_TEST/docs/beta/evidence/b7/notes.txt"
		  exit 0
		fi
		exit 5
	SH
	printf '#!/bin/sh\nexit 0\n' >"$tmp/bin/age"
	chmod +x "$tmp/bin/"*
	printf 'BACKUP_S3_PROVIDER=AWS\nBACKUP_S3_REGION=eu-central-1\nBACKUP_S3_ENDPOINT=https://s3.eu-central-1.amazonaws.com\nBACKUP_S3_BUCKET=alethia-prod-backup-123456789012\nBACKUP_PREFIX=alethia-prod\nDRILL_EVIDENCE_PREFIX=evidence/\nDRILL_AGE_IDENTITY_SECRET=alethia/backup/drill-age-identity\n' >"$tmp/drill.env"

	local out rc
	scenario() { # scenario [flag-files…]
		rm -rf "$tmp/fake" "$tmp/repo/docs"
		mkdir -p "$tmp/fake"
		printf '{"instanceId":"i-0123456789abcdef0","accountId":"123456789012","region":"eu-central-1"}' >"$tmp/fake/identity"
		printf '{"AccessKeyId":"ASIASELFTEST","SecretAccessKey":"%s","Token":"%s"}' "$secret_key" "$session" >"$tmp/fake/creds"
		jq -n --arg s "# public key: age1xyz"$'\n'"$age_secret" '{SecretString: $s}' >"$tmp/fake/sm-response"
		local f
		for f in "$@"; do : >"$tmp/fake/$f"; done
	}
	go() { # go <env-file>
		rc=0
		out="$(FAKE="$tmp/fake" REPO_UNDER_TEST="$tmp/repo" PATH="$tmp/bin:$PATH" DRILL_RESTORE_SCRIPT="$tmp/bin/fake-drill" \
			DRILL_IMDS_URL=http://imds.invalid DRILL_SECRETS_ENDPOINT=https://sm.invalid BACKUP_WORKDIR="$tmp" \
			bash "$tmp/repo/scripts/ops/restore-drill-ec2.sh" --env-file "$1" 2>&1)" || rc=$?
	}
	check() { # check <name> <condition, as a string for eval>
		if eval "$2"; then printf 'ok    %s\n' "$1"; else printf 'FAIL  %s\n%s\n' "$1" "$(printf '%s' "$out" | sed 's/^/      /')"; fails=$((fails + 1)); fi
	}
	no_leak() {
		[[ "$out" != *"$secret_key"* && "$out" != *"$session"* && "$out" != *"AGE-SECRET-KEY"* ]]
	}

	scenario
	go "$tmp/drill.env"
	local args uploads leftovers want_uploads result
	args=" $(tr '\n' ' ' <"$tmp/fake/drill-args")"
	uploads="$(cut -d/ -f2- "$tmp/fake/uploads" | tr '\n' ' ')"
	want_uploads="evidence/i-0123456789abcdef0/2026-12-07-restore-drill.log evidence/i-0123456789abcdef0/2026-12-07-restore-drill.md evidence/i-0123456789abcdef0/result.json "
	leftovers="$(find "$tmp" -mindepth 1 -maxdepth 2 -name 'alethia-backup.*' 2>/dev/null)"
	check "a passing drill exits 0" '[ "$rc" = 0 ]'
	check "the drill ran with --target drill --execute --observer agent" '[[ "$args" == " --target drill --execute "* && "$args" == *" --observer agent "* ]]'
	check "the upload list holds only record-shaped files" '[[ "$uploads" != *notes.txt* ]]'
	check "the clock starts at boot (--started-at is passed)" '[[ "$args" == *" --started-at "* ]]'
	check "the drill got a 0600 identity file holding the age key" '[ "$(cat "$tmp/fake/identity-mode")" = 600 ] && [ -e "$tmp/fake/identity-ok" ]'
	check "no credential or identity reaches the output" no_leak
	check "Secrets Manager is called through a config file, signed for the region" 'grep -q "aws-sigv4 = \"aws:amz:eu-central-1:secretsmanager\"" "$tmp/fake/last-curl-config"'
	check "the session credentials travel in that 0600 file" 'grep -q "$session" "$tmp/fake/last-curl-config"'
	check "the record, the log, then result.json are uploaded under the instance id" '[ "$uploads" = "$want_uploads" ]'
	check "nothing secret is left in the work directory" '[ -z "$leftovers" ]'
	check "one IMDSv2 session serves every metadata read" '[ "$(wc -l <"$tmp/fake/imds-puts" | tr -d " ")" = 1 ]'

	# result.json content, through the pure writer.
	INSTANCE_ID="i-0123456789abcdef0"
	write_result "$tmp/r.json" 0 1700000000 "/x/2026-12-07-restore-drill.md" "/x/2026-12-07-restore-drill.log"
	result="$(jq -r '[.verdict, .record, .log, (.exitCode | tostring)] | join(" ")' "$tmp/r.json")"
	check "result.json says pass and names both files" '[ "$result" = "pass 2026-12-07-restore-drill.md 2026-12-07-restore-drill.log 0" ]'
	write_result "$tmp/r.json" 0 1700000000
	result="$(jq -r .verdict "$tmp/r.json")"
	check "exit 0 with no record is still a fail" '[ "$result" = fail ]'
	write_result "$tmp/r.json" 5 1700000000 "/x/2026-12-07-restore-drill.md"
	result="$(jq -r '.verdict + " " + (.exitCode | tostring)' "$tmp/r.json")"
	check "a non-zero exit is a fail" '[ "$result" = "fail 5" ]'

	scenario drill-fail
	go "$tmp/drill.env"
	check "a failing drill keeps its exit code" '[ "$rc" = 5 ]'
	check "a failing drill still uploads result.json" 'grep -q "result.json$" "$tmp/fake/uploads"'

	scenario upload-fail
	go "$tmp/drill.env"
	check "a passing drill whose evidence cannot be uploaded exits non-zero" '[ "$rc" -ne 0 ]'

	scenario sm-fail
	go "$tmp/drill.env"
	check "a refused Secrets Manager call stops before the drill" '[ "$rc" -ne 0 ] && [ ! -e "$tmp/fake/drill-args" ]'

	scenario
	printf '{"SecretString":"not an identity"}' >"$tmp/fake/sm-response"
	go "$tmp/drill.env"
	check "a secret holding no age identity is refused, without echoing it" '[ "$rc" -ne 0 ] && [ ! -e "$tmp/fake/drill-args" ] && [[ "$out" != *"not an identity"* ]]'

	scenario
	printf '{"instanceId":"i-0123456789abcdef0","accountId":"123456789012","region":"us-east-1"}' >"$tmp/fake/identity"
	go "$tmp/drill.env"
	check "an instance outside the bucket's region is refused" '[ "$rc" -ne 0 ] && [[ "$out" == *"runs in us-east-1"* ]]'

	scenario
	grep -v DRILL_AGE_IDENTITY_SECRET "$tmp/drill.env" >"$tmp/no-secret.env"
	go "$tmp/no-secret.env"
	check "a missing secret name is refused" '[ "$rc" -ne 0 ] && [[ "$out" == *"DRILL_AGE_IDENTITY_SECRET is unset"* ]]'

	scenario
	go "$tmp/does-not-exist.env"
	check "an unreadable env file is refused with 64" '[ "$rc" = 64 ]'

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
	case "${1:-}" in
		--self-test) self_test; return ;;
		-h | --help) usage; return 0 ;;
		--env-file) ENV_FILE="${2:-}" ;;
		*) usage >&2; die "usage: restore-drill-ec2.sh --env-file FILE | --self-test" 64 ;;
	esac
	run
}

main "$@"
