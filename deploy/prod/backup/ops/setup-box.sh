#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# One-time (and safely repeatable) setup of the off-box backup ON the production box (BKP-L1, #7243).
#
#   setup-box.sh --values FILE|-  [--dry-run] [--no-first-run]
#   setup-box.sh --self-test
#
#   --values FILE   a dotenv file with the backup.env keys (see ../backup.env.example). `-` reads it
#                   from stdin, so it can come over the SSH connection and never sit on the box:
#                     ssh root@<box> /opt/alethia/deploy/prod/backup/ops/setup-box.sh --values - < values.env
#   --dry-run       validate the values and print what would change; change nothing
#   --no-first-run  install and enable everything, but do not take the first copy now
#
# What it does, each step a no-op when already done:
#   1. installs `age` if it is missing (apt-get)
#   2. writes /etc/alethia/backup.env (root:root 0600) from the values; unchanged values, unchanged file
#   3. installs the four systemd units from ../ and enables both timers
#   4. takes the first copy (alethia-backup.service) and runs `backup.sh status`
# and ends with one line: RESULT: PASS, or RESULT: FAIL (<step>). Exit 0 only on PASS.
#
# Why values are passed in rather than read from the vault here: the box holds no AWS credential.
# The deploy reads `alethia/prod/env` in CI over OIDC (.github/workflows/deploy-console.yml,
# scripts/ci/deploy-console-assemble-env.sh) and ships only the assembled .env. Giving the box a
# vault credential just for this would widen what a box compromise reaches.
#
# Nothing secret is printed: key names and "set" only. Never add `set -x`.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$(cd "$HERE/.." && pwd)"
# shellcheck source=../lib.sh source-path=SCRIPTDIR
. "$BACKUP_DIR/lib.sh"

# SETUP_ROOT prefixes every path this writes. It exists for --self-test only; on the box it is empty.
SETUP_ROOT="${SETUP_ROOT:-}"
ENV_FILE="$SETUP_ROOT/etc/alethia/backup.env"
UNIT_DIR="$SETUP_ROOT/etc/systemd/system"
UNITS=(alethia-backup.service alethia-backup.timer alethia-backup-tombstones.service alethia-backup-tombstones.timer)
TIMERS=(alethia-backup.timer alethia-backup-tombstones.timer)
# The command whose presence means age is installed. Overridden by --self-test only.
SETUP_AGE_CMD="${SETUP_AGE_CMD:-age}"

# The keys written to backup.env, in this order. Anything else in the values file is ignored.
SETUP_KEYS=(BACKUP_S3_ENDPOINT BACKUP_S3_REGION BACKUP_S3_PROVIDER BACKUP_S3_BUCKET
	BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY BACKUP_S3_SSE_KMS_KEY_ID BACKUP_PREFIX
	BACKUP_RETENTION BACKUP_AGE_RECIPIENTS BACKUP_KEEP_DAILY BACKUP_KEEP_WEEKLY BACKUP_MAX_AGE_HOURS
	BACKUP_WORKDIR BACKUP_RCLONE_IMAGE)
SETUP_REQUIRED=(BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
	BACKUP_AGE_RECIPIENTS)
# Production encrypts to primary, breakglass and drill.
SETUP_MIN_RECIPIENTS=3

WORK=""
DRY_RUN=0

#######################################
# Removes the working directory (the copy of the values) on any exit.
#######################################
cleanup() {
	if [ -n "$WORK" ] && [ -d "$WORK" ]; then
		rm -rf "$WORK"
	fi
}
trap cleanup EXIT

#######################################
# Prints usage.
#######################################
usage() {
	sed -n '5,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

#######################################
# Prints the final verdict and exits: 0 for PASS, 1 for FAIL (the step is named).
#######################################
verdict() {
	if [ "$1" = PASS ]; then
		printf '\nRESULT: PASS\n'
		exit 0
	fi
	printf '\nRESULT: FAIL (%s)\n' "$2"
	exit 1
}

#######################################
# Reads the whitelisted keys from VALUES into the variables of the same names, applies the
# production defaults (AWS, bucket retention, alethia-prod), and validates them. Prints the reason
# and returns 1 on the first problem. Never prints a value.
#######################################
load_values() {
	local values="$1" k v n=0 r
	[ -r "$values" ] || { printf 'cannot read the values file\n' >&2; return 1; }
	for k in "${SETUP_KEYS[@]}"; do
		printf -v "$k" '%s' "$(env_file_value "$values" "$k")"
	done
	BACKUP_S3_PROVIDER="${BACKUP_S3_PROVIDER:-AWS}"
	BACKUP_RETENTION="${BACKUP_RETENTION:-bucket}"
	BACKUP_PREFIX="${BACKUP_PREFIX:-alethia-prod}"
	for k in "${SETUP_REQUIRED[@]}"; do
		[ -n "${!k}" ] || { printf 'missing value: %s\n' "$k" >&2; return 1; }
	done
	for k in "${SETUP_KEYS[@]}"; do
		v="${!k}"
		# Everything is written double-quoted, for systemd and for `set -a; . backup.env` alike, so
		# a character either would read specially is refused rather than escaped.
		case "$v" in
			*\"* | *\\* | *\$* | *\`* | *$'\n'*)
				printf 'value of %s holds a quote, backslash, dollar, backtick or newline\n' "$k" >&2
				return 1
				;;
		esac
	done
	case "$BACKUP_RETENTION" in
		bucket | script) ;;
		*) printf "BACKUP_RETENTION must be 'bucket' or 'script'\n" >&2; return 1 ;;
	esac
	for r in $BACKUP_AGE_RECIPIENTS; do
		[[ "$r" =~ $BACKUP_AGE_RECIPIENT_RE ]] || { printf 'BACKUP_AGE_RECIPIENTS holds something that is not an age public key\n' >&2; return 1; }
		n=$((n + 1))
	done
	[ "$n" -ge "$SETUP_MIN_RECIPIENTS" ] || {
		printf 'BACKUP_AGE_RECIPIENTS has %s key(s); production needs %s (primary, breakglass, drill)\n' "$n" "$SETUP_MIN_RECIPIENTS" >&2
		return 1
	}
	if [ "$BACKUP_RETENTION" = bucket ] && [ "$BACKUP_S3_PROVIDER" = AWS ] && [ -z "$BACKUP_S3_SSE_KMS_KEY_ID" ]; then
		printf 'the AWS backup bucket encrypts with SSE-KMS: BACKUP_S3_SSE_KMS_KEY_ID (the key ARN) is required\n' >&2
		return 1
	fi
}

#######################################
# Prints backup.env's content from the loaded values: every set key, double-quoted, in SETUP_KEYS order.
#######################################
render_env() {
	local k
	printf '# Written by deploy/prod/backup/ops/setup-box.sh. Root-only. Re-run that script to change it.\n'
	for k in "${SETUP_KEYS[@]}"; do
		[ -n "${!k}" ] || continue
		printf '%s="%s"\n' "$k" "${!k}"
	done
}

#######################################
# Prints which keys are set, never their values.
#######################################
describe_values() {
	local k
	for k in "${SETUP_KEYS[@]}"; do
		if [ -n "${!k}" ]; then printf '  %-30s set\n' "$k"; fi
	done
	printf '  recipients: %s\n' "$(wc -w <<<"$BACKUP_AGE_RECIPIENTS" | tr -d ' ')"
}

#######################################
# Runs a command, or only says it would in --dry-run.
#######################################
act() {
	if [ "$DRY_RUN" -eq 1 ]; then
		printf '  would run: %s\n' "$*"
	else
		"$@"
	fi
}

#######################################
# Installs SRC at DEST with MODE when DEST is absent or differs. Prints "changed" or "unchanged".
#######################################
install_if_changed() {
	local src="$1" dest="$2" mode="$3"
	if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
		printf 'unchanged'
		return 0
	fi
	if [ "$DRY_RUN" -eq 0 ]; then
		mkdir -p "$(dirname "$dest")"
		if [ -n "$SETUP_ROOT" ]; then
			install -m "$mode" "$src" "$dest"
		else
			install -o root -g root -m "$mode" "$src" "$dest"
		fi
	fi
	printf 'changed'
}

#######################################
# The setup itself. Arguments: the values path, and whether to take the first copy (1/0).
#######################################
setup() {
	local values="$1" first_run="$2" state changed_units=0 u rc
	if [ -z "$SETUP_ROOT" ] && [ "$(id -u)" -ne 0 ]; then
		verdict FAIL "run as root on the box"
	fi
	WORK="$(secret_dir)"
	if [ "$values" = - ]; then
		(umask 077 && cat >"$WORK/values.env")
		values="$WORK/values.env"
	fi

	printf '== 1/5 values\n'
	load_values "$values" || verdict FAIL "values"
	describe_values

	printf '== 2/5 age\n'
	if command -v "$SETUP_AGE_CMD" >/dev/null 2>&1; then
		printf '  age is installed\n'
	else
		act apt-get install -y age || verdict FAIL "installing age"
	fi

	printf '== 3/5 %s\n' "${ENV_FILE#"$SETUP_ROOT"}"
	(umask 077 && render_env >"$WORK/backup.env")
	state="$(install_if_changed "$WORK/backup.env" "$ENV_FILE" 600)" || verdict FAIL "writing backup.env"
	printf '  %s%s\n' "$state" "$([ "$DRY_RUN" -eq 1 ] && [ "$state" = changed ] && printf ' (would write)')"

	printf '== 4/5 systemd units\n'
	for u in "${UNITS[@]}"; do
		[ -f "$BACKUP_DIR/$u" ] || verdict FAIL "unit $u is not in $BACKUP_DIR (is the backup code deployed?)"
		state="$(install_if_changed "$BACKUP_DIR/$u" "$UNIT_DIR/$u" 644)" || verdict FAIL "installing $u"
		printf '  %-36s %s\n' "$u" "$state"
		[ "$state" = unchanged ] || changed_units=1
	done
	if [ "$changed_units" -eq 1 ]; then
		act systemctl daemon-reload || verdict FAIL "systemctl daemon-reload"
	fi
	act systemctl enable --now "${TIMERS[@]}" || verdict FAIL "enabling the timers"

	printf '== 5/5 first copy and status\n'
	if [ "$first_run" -eq 0 ]; then
		printf '  skipped (--no-first-run)\n'
		[ "$DRY_RUN" -eq 1 ] && printf '\nDRY RUN: nothing was changed\n'
		verdict PASS
	fi
	if [ "$DRY_RUN" -eq 1 ]; then
		printf '  would run: systemctl start alethia-backup.service\n'
		printf '  would run: backup.sh status\n'
		printf '\nDRY RUN: nothing was changed\n'
		exit 0
	fi
	printf '  taking the first copy (this waits until it finishes)\n'
	if ! systemctl start alethia-backup.service; then
		printf '  the backup unit failed; its log: journalctl -u alethia-backup.service -n 50\n'
		verdict FAIL "first backup"
	fi
	set +e
	(
		for u in "${SETUP_KEYS[@]}"; do
			[ -n "${!u}" ] && export "${u?}"
		done
		"$BACKUP_DIR/backup.sh" status
	)
	rc=$?
	set -e
	[ "$rc" -eq 0 ] || verdict FAIL "backup.sh status exited $rc"
	verdict PASS
}

#######################################
# Hermetic checks: value validation, the rendered file, and a dry run and two real runs against a
# temporary root with stand-ins for systemctl, apt-get and age. Every check counts toward the exit code.
#######################################
self_test() {
	local fails=0 tmp got k1 k2 k3
	tmp="$(secret_dir)"
	WORK="$tmp"
	check() { # check <name> <got> <want>
		if [ "$2" = "$3" ]; then
			printf 'ok    %s\n' "$1"
		else
			printf 'FAIL  %s\n      got:  %q\n      want: %q\n' "$1" "$2" "$3"
			fails=$((fails + 1))
		fi
	}
	k1="age1$(printf 'q%.0s' {1..58})"
	k2="age1$(printf 'p%.0s' {1..58})"
	k3="age1$(printf 'z%.0s' {1..58})"
	good() {
		printf 'BACKUP_S3_ENDPOINT=https://s3.eu-central-1.amazonaws.com\nBACKUP_S3_REGION=eu-central-1\n'
		printf 'BACKUP_S3_BUCKET=bucket\nBACKUP_S3_ACCESS_KEY_ID=AKIDEXAMPLE\nBACKUP_S3_SECRET_ACCESS_KEY=secret/EXAMPLE+1\n'
		printf 'BACKUP_S3_SSE_KMS_KEY_ID=arn:aws:kms:eu-central-1:111111111111:key/example\n'
		printf 'BACKUP_AGE_RECIPIENTS="%s %s %s"\n' "$k1" "$k2" "$k3"
		printf 'UNRELATED=ignored\n'
	}
	loads() { # loads <file> -> accepted|refused
		if (load_values "$1" >/dev/null 2>&1); then printf accepted; else printf refused; fi
	}

	good >"$tmp/good.env"
	check "complete production values are accepted" "$(loads "$tmp/good.env")" accepted
	grep -v '^BACKUP_S3_SECRET_ACCESS_KEY=' "$tmp/good.env" >"$tmp/v.env"
	check "a missing secret is refused" "$(loads "$tmp/v.env")" refused
	sed "s/ $k3//" "$tmp/good.env" >"$tmp/v.env"
	check "two recipients are refused (production needs three)" "$(loads "$tmp/v.env")" refused
	sed "s/$k2/${k2}x/" "$tmp/good.env" >"$tmp/v.env"
	check "a malformed recipient is refused" "$(loads "$tmp/v.env")" refused
	grep -v '^BACKUP_S3_SSE_KMS_KEY_ID=' "$tmp/good.env" >"$tmp/v.env"
	check "bucket mode on AWS without the KMS key is refused" "$(loads "$tmp/v.env")" refused
	{ cat "$tmp/good.env"; printf 'BACKUP_RETENTION=Bucket\n'; } >"$tmp/v.env"
	check "a mistyped retention mode is refused" "$(loads "$tmp/v.env")" refused
	# shellcheck disable=SC2016 # the command substitution is the value under test, unexpanded
	{ cat "$tmp/good.env"; printf 'BACKUP_PREFIX=a$(touch PWNED)\n'; } >"$tmp/v.env"
	check "a value with a dollar is refused" "$(loads "$tmp/v.env")" refused

	got="$(load_values "$tmp/good.env" && render_env)"
	check "rendered: retention defaults to bucket" "$(grep -c '^BACKUP_RETENTION="bucket"$' <<<"$got")" 1
	check "rendered: provider defaults to AWS" "$(grep -c '^BACKUP_S3_PROVIDER="AWS"$' <<<"$got")" 1
	check "rendered: recipients quoted on one line" "$(grep -c "^BACKUP_AGE_RECIPIENTS=\"$k1 $k2 $k3\"\$" <<<"$got")" 1
	check "rendered: unknown keys are dropped" "$(grep -c '^UNRELATED' <<<"$got")" 0
	check "rendered: an unset optional key is not written" "$(grep -c '^BACKUP_WORKDIR' <<<"$got")" 0

	# Stand-ins on PATH: record every call, succeed. `age` is absent, so the install path runs.
	mkdir -p "$tmp/bin" "$tmp/root"
	for c in systemctl apt-get; do
		printf '#!/usr/bin/env bash\nprintf "%%s %%s\\n" "%s" "$*" >>"%s/calls"\n' "$c" "$tmp" >"$tmp/bin/$c"
		chmod +x "$tmp/bin/$c"
	done
	run() { # run <args…>: this script against the temporary root; prints its exit code
		local code=0
		SETUP_ROOT="$tmp/root" SETUP_AGE_CMD=alethia-selftest-no-such-age PATH="$tmp/bin:/usr/bin:/bin" bash "${BASH_SOURCE[0]}" "$@" >"$tmp/out" 2>&1 || code=$?
		printf '%s' "$code"
	}
	: >"$tmp/calls"
	check "a dry run exits 0" "$(run --values "$tmp/good.env" --dry-run)" 0
	check "a dry run writes no backup.env" "$([ -e "$tmp/root/etc/alethia/backup.env" ] && printf written || printf absent)" absent
	check "a dry run installs no unit" "$(find "$tmp/root" -type f | wc -l | tr -d ' ')" 0
	check "a dry run runs nothing" "$(wc -l <"$tmp/calls" | tr -d ' ')" 0
	check "a dry run never prints the secret" "$(grep -c 'secret/EXAMPLE' "$tmp/out")" 0

	check "a real run passes" "$(run --values - --no-first-run <"$tmp/good.env")" 0
	check "it says PASS" "$(grep -c '^RESULT: PASS$' "$tmp/out")" 1
	check "it never prints the secret" "$(grep -c 'secret/EXAMPLE' "$tmp/out")" 0
	check "backup.env is 0600" "$(stat -c %a "$tmp/root/etc/alethia/backup.env" 2>/dev/null || stat -f %Lp "$tmp/root/etc/alethia/backup.env")" 600
	check "backup.env reads back through the dotenv reader" \
		"$(env_file_value "$tmp/root/etc/alethia/backup.env" BACKUP_AGE_RECIPIENTS)" "$k1 $k2 $k3"
	check "all four units installed" "$(find "$tmp/root/etc/systemd/system" -type f | wc -l | tr -d ' ')" 4
	check "age installed when missing" "$(grep -c '^apt-get install -y age$' "$tmp/calls")" 1
	check "the timers are enabled" \
		"$(grep -c '^systemctl enable --now alethia-backup.timer alethia-backup-tombstones.timer$' "$tmp/calls")" 1

	: >"$tmp/calls"
	check "a second identical run passes" "$(run --values "$tmp/good.env" --no-first-run)" 0
	check "and changes no file" "$(grep -c ' changed$' "$tmp/out")" 0
	check "and skips daemon-reload" "$(grep -c 'daemon-reload' "$tmp/calls")" 0

	check "bad values fail before anything runs" "$(run --values "$tmp/v.env")" 1
	check "and say which step" "$(grep -c '^RESULT: FAIL (values)$' "$tmp/out")" 1

	if [ "$fails" -ne 0 ]; then
		printf '\n%s self-test assertion(s) failed\n' "$fails"
		return 1
	fi
	printf '\nall self-test assertions passed\n'
}

main() {
	local values="" first_run=1
	while [ $# -gt 0 ]; do
		case "$1" in
			--values) values="${2:-}"; shift 2 || die "--values needs a file or -" 64 ;;
			--dry-run) DRY_RUN=1; shift ;;
			--no-first-run) first_run=0; shift ;;
			--self-test) self_test; return ;;
			-h | --help) usage; return 0 ;;
			*) usage >&2; exit 64 ;;
		esac
	done
	[ -n "$values" ] || { usage >&2; exit 64; }
	setup "$values" "$first_run"
}

main "$@"
