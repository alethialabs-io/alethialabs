# shellcheck shell=bash disable=SC2034  # constants here are read by the scripts that source this file
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Helpers shared by deploy/prod/backup/backup.sh and scripts/ops/restore-drill.sh (REL-L7, #6908).
#
# Sourced, never executed. Nothing in here reads a secret from anywhere but the environment or a
# file the operator named, and nothing in here prints one: a secret is only ever written to a 0600
# file inside a 0700 directory made by `secret_dir`, which the caller removes on exit, and handed to
# a container with `--env-file`, so it never appears in a process listing either.
#
# Never add `set -x` to anything that sources this file. Both callers handle storage keys.

# The rclone image that does every object-store transfer. Pinned: a floating tag would let the
# nightly change behaviour between two runs with nothing in this repository changing. Before
# bumping it, re-read what the runbook's "Object Lock and the pinned rclone" section establishes
# from this version's source: the Object Lock uploads depend on it.
BACKUP_RCLONE_IMAGE="${BACKUP_RCLONE_IMAGE:-rclone/rclone:1.68.2}"

# Stamps sort lexicographically in time order, which is what retention and "newest" rely on.
BACKUP_STAMP_RE='^[0-9]{8}T[0-9]{6}Z$'

# One age X25519 recipient. ssh recipients are not accepted: the restore runbook names one kind of
# key, and a second kind is a second thing to get wrong on the night it matters.
BACKUP_AGE_RECIPIENT_RE='^age1[02-9ac-hj-np-z]{58}$'

# The file names a daily copy is made of. The manifest is written LAST, so a directory without one
# is a copy that did not finish, and nothing treats it as a backup.
BACKUP_FILE_DUMP="postgres.dump.age"
BACKUP_FILE_STORAGE="storage.tar.gz.age"
BACKUP_FILE_TOMBSTONES="tombstones.csv.age"
BACKUP_FILE_MANIFEST="manifest.json"

# The tombstone columns, in the order both the export and the merge use. Named rather than `*`, so a
# column added later cannot shift the CSV under a restore that was written against the old order.
BACKUP_TOMBSTONE_COLUMNS="id, subject_email_sha256, erased_user_id, case_reference, erased_at, scope, replayed_at, created_at"

#######################################
# Prints a timestamped progress line on stderr.
#######################################
log() {
	printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

#######################################
# Prints an error on stderr and exits with the given code (default 1).
#######################################
die() {
	local msg="$1" code="${2:-1}"
	printf 'error: %s\n' "$msg" >&2
	exit "$code"
}

#######################################
# Exits unless every named command is on PATH.
#######################################
require_cmd() {
	local c
	for c in "$@"; do
		command -v "$c" >/dev/null 2>&1 || die "'$c' is not installed (see docs/ops/restore-runbook.md, 'Prerequisites')"
	done
}

#######################################
# Exits unless every named environment variable is set and non-empty. Names only, never values.
#######################################
require_env() {
	local v missing=""
	for v in "$@"; do
		[ -n "${!v:-}" ] || missing="$missing $v"
	done
	[ -z "$missing" ] || die "required environment variable(s) unset:$missing (see deploy/prod/backup/backup.env.example)"
}

#######################################
# Reads KEY's value from a dotenv FILE without sourcing it, so the file cannot run code. The last
# assignment wins, as it does for docker compose. One pair of surrounding quotes is removed.
# Prints nothing (and returns 0) when the key is absent.
#######################################
env_file_value() {
	local file="$1" key="$2" line value
	[ -r "$file" ] || return 0
	line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" | tail -n 1 || true)"
	[ -n "$line" ] || return 0
	value="${line#*=}"
	case "$value" in
		\"*\") value="${value#\"}"; value="${value%\"}" ;;
		\'*\') value="${value#\'}"; value="${value%\'}" ;;
	esac
	printf '%s' "$value"
}

#######################################
# Replaces KEY's assignment in a dotenv FILE, or appends one. Used only on files this tooling wrote.
#######################################
env_file_set() {
	local file="$1" key="$2" value="$3" tmp
	tmp="$(mktemp "${file}.XXXXXX")"
	awk -v k="$key" -v v="$value" '
		BEGIN { done = 0 }
		$0 ~ "^[[:space:]]*" k "=" { if (!done) { print k "=" v; done = 1 }; next }
		{ print }
		END { if (!done) print k "=" v }
	' "$file" >"$tmp"
	chmod 600 "$tmp"
	mv -f "$tmp" "$file"
}

#######################################
# Prints a fresh 0700 directory. Everything secret goes in here, and the caller removes it on exit.
#######################################
secret_dir() {
	local base="${1:-${TMPDIR:-/tmp}}" d
	d="$(umask 077 && mktemp -d "${base%/}/alethia-backup.XXXXXX")"
	chmod 700 "$d"
	printf '%s' "$d"
}

#######################################
# Prints 48 random hex characters. For drill-only passwords, never for anything kept.
#######################################
random_hex() {
	od -An -tx1 -N24 /dev/urandom | tr -d ' \n'
}

#######################################
# Prints the epoch seconds of an RFC 3339 UTC instant (YYYY-MM-DDTHH:MM:SSZ), on GNU or BSD date.
# Fails, rather than printing something, when neither can parse it: a date that silently became 0
# would make every backup look 56 years old, or a fallback that printed a usage message would make
# the age a string.
#######################################
epoch_of() {
	local iso="$1" out=""
	[[ "$iso" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
	out="$(date -u -d "$iso" +%s 2>/dev/null || true)"
	if ! [[ "$out" =~ ^[0-9]+$ ]]; then
		out="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$iso" +%s 2>/dev/null || true)"
	fi
	[[ "$out" =~ ^[0-9]+$ ]] || return 1
	printf '%s' "$out"
}

#######################################
# Prints the SHA-256 of a file, with sha256sum (Linux) or shasum (macOS).
#######################################
sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	else
		shasum -a 256 "$1" | awk '{print $1}'
	fi
}

#######################################
# Prints a file's size in bytes, portably.
#######################################
bytes_of() {
	wc -c <"$1" | tr -d ' '
}

#######################################
# Validates BACKUP_AGE_RECIPIENTS (space-separated public keys) and prints `-r <key>` arguments,
# one per line, for `age`. A public key is not a secret; the matching identity never comes near
# the production box, so a compromised box can write backups but cannot read one.
#######################################
age_recipient_args() {
	local r n=0
	for r in ${BACKUP_AGE_RECIPIENTS:-}; do
		[[ "$r" =~ $BACKUP_AGE_RECIPIENT_RE ]] || die "BACKUP_AGE_RECIPIENTS holds something that is not an age X25519 public key"
		printf -- '-r\n%s\n' "$r"
		n=$((n + 1))
	done
	[ "$n" -gt 0 ] || die "BACKUP_AGE_RECIPIENTS is empty"
}

#######################################
# Validates BACKUP_RETENTION and prints the mode: `script` (the default) or `bucket`.
#   script  backup.sh deletes old copies itself (`rclone purge`), so the box key needs delete. For a
#           store with no lifecycle rules, e.g. a self-hosted S3-compatible one.
#   bucket  backup.sh never deletes anything. The bucket's lifecycle rules expire old copies and its
#           Object Lock default retention keeps them immutable meanwhile; the box key has no delete.
#           Production runs this mode against AWS S3.
# Anything else stops the run before a byte is written: a typo must not fall back to deleting.
#######################################
retention_mode() {
	case "${BACKUP_RETENTION:-script}" in
		script) printf 'script' ;;
		bucket) printf 'bucket' ;;
		*) die "BACKUP_RETENTION must be 'script' or 'bucket'" ;;
	esac
}

#######################################
# Writes the off-box remote's rclone configuration into DIR/offbox.env (0600) and prints its path.
# rclone reads a remote named OFFBOX from RCLONE_CONFIG_OFFBOX_*; no config file is ever written.
#######################################
offbox_env_file() {
	local f="$1/offbox.env" mode
	require_env BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
	mode="$(retention_mode)" || exit 1
	(
		umask 077
		{
			printf 'RCLONE_CONFIG_OFFBOX_TYPE=s3\n'
			printf 'RCLONE_CONFIG_OFFBOX_PROVIDER=%s\n' "${BACKUP_S3_PROVIDER:-Other}"
			printf 'RCLONE_CONFIG_OFFBOX_ENDPOINT=%s\n' "$BACKUP_S3_ENDPOINT"
			printf 'RCLONE_CONFIG_OFFBOX_REGION=%s\n' "${BACKUP_S3_REGION:-}"
			printf 'RCLONE_CONFIG_OFFBOX_ACCESS_KEY_ID=%s\n' "$BACKUP_S3_ACCESS_KEY_ID"
			printf 'RCLONE_CONFIG_OFFBOX_SECRET_ACCESS_KEY=%s\n' "$BACKUP_S3_SECRET_ACCESS_KEY"
			# Temporary credentials (an STS session: an OIDC role, an instance role, an Identity Center
			# recovery session) carry a third part. A static IAM user key has none.
			if [ -n "${BACKUP_S3_SESSION_TOKEN:-}" ]; then
				printf 'RCLONE_CONFIG_OFFBOX_SESSION_TOKEN=%s\n' "$BACKUP_S3_SESSION_TOKEN"
			fi
			# A bucket encrypted with a KMS key: rclone must be told, both so S3 uses THAT key (a bare
			# "aws:kms" header would pick the AWS-managed key instead) and so rclone stops reading the
			# ETag as an MD5, which under SSE-KMS it is not (rclone backend/s3/s3.go, etagIsNotMD5).
			# Without this, uploads fail rclone's post-transfer hash check.
			if [ -n "${BACKUP_S3_SSE_KMS_KEY_ID:-}" ]; then
				printf 'RCLONE_CONFIG_OFFBOX_SERVER_SIDE_ENCRYPTION=aws:kms\n'
				printf 'RCLONE_CONFIG_OFFBOX_SSE_KMS_KEY_ID=%s\n' "$BACKUP_S3_SSE_KMS_KEY_ID"
			fi
			# Bucket mode means an Object Lock bucket, and S3 refuses an upload into one that carries
			# neither Content-MD5 nor an SDK checksum header. Every upload goes multipart: rclone sets
			# Content-MD5 on each UploadPart from the bytes it sends, whatever the source can hash, and
			# records the whole file's MD5 as metadata so `rclone check` and a download can verify it.
			# This is rclone's own documented workaround for Object Lock buckets at the pinned version.
			# See docs/ops/restore-runbook.md, "Object Lock and the pinned rclone".
			if [ "$mode" = bucket ]; then
				printf 'RCLONE_CONFIG_OFFBOX_UPLOAD_CUTOFF=0\n'
			fi
			# Never try to create the bucket: the backup key should not be allowed to, and a typo'd
			# bucket name should fail loudly instead of quietly creating a second, unwatched one.
			printf 'RCLONE_S3_NO_CHECK_BUCKET=true\n'
		} >"$f"
	)
	printf '%s' "$f"
}

#######################################
# Prints the off-box path for a sub-path: OFFBOX:<bucket>/<prefix>/<sub>.
#######################################
offbox_path() {
	printf 'OFFBOX:%s/%s/%s' "$BACKUP_S3_BUCKET" "${BACKUP_PREFIX:-alethia-prod}" "$1"
}

#######################################
# Runs rclone in a throwaway container: rclone_run <network|-> <env-file> <host-dir> <rclone args…>
# The host dir is mounted at /work. "-" means the default bridge network (egress to the off-box
# store); a compose network name reaches that project's SeaweedFS by its service name.
#######################################
rclone_run() {
	local network="$1" envfile="$2" hostdir="$3"
	shift 3
	local net_args=()
	[ "$network" = "-" ] || net_args=(--network "$network")
	docker run --rm "${net_args[@]}" --env-file "$envfile" \
		-v "$hostdir:/work" --user "$(id -u):$(id -g)" \
		-e HOME=/work -e RCLONE_CONFIG=/dev/null \
		"$BACKUP_RCLONE_IMAGE" "$@"
}

#######################################
# Prints the id of the (first) container of a compose PROJECT's SERVICE, running or not.
#######################################
compose_container() {
	docker ps -a -q \
		--filter "label=com.docker.compose.project=$1" \
		--filter "label=com.docker.compose.service=$2" | head -n 1
}

#######################################
# Prints the first network a container is attached to.
#######################################
container_network() {
	docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$1" | head -n 1
}

#######################################
# Prints a container's ALETHIA_SOURCE_COMMIT (the commit its image was built from), if it has one.
#######################################
container_source_commit() {
	docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" |
		sed -n 's/^ALETHIA_SOURCE_COMMIT=//p' | head -n 1
}

#######################################
# Retention. Reads "<stamp> <complete|incomplete>" lines on stdin and prints the stamps to delete so
# that the newest KEEP complete copies survive. Everything older than the oldest kept complete copy
# goes, complete or not; an incomplete copy NEWER than it stays, because it may be a run in progress.
# Pure, so --self-test can hold it to that. Lines with a malformed stamp are ignored, never deleted.
#######################################
retention_select() {
	local keep="$1"
	[[ "$keep" =~ ^[0-9]+$ ]] && [ "$keep" -ge 1 ] || die "retention keep count must be a positive integer"
	# `|| true`: a listing with no well-formed line is nothing to delete, not a failure that stops
	# the caller under pipefail.
	{ grep -E '^[0-9]{8}T[0-9]{6}Z (complete|incomplete)$' || true; } | sort -r | awk -v keep="$keep" '
		{ if (kept >= keep) { print $1; next } if ($2 == "complete") kept++ }
	'
}

#######################################
# Reads one file's sha256 out of a manifest written by backup.sh.
#######################################
manifest_sha256() {
	sed -n "s/.*\"$2\": {\"bytes\": [0-9]*, \"sha256\": \"\([0-9a-f]\{64\}\)\"}.*/\1/p" "$1" | head -n 1
}

#######################################
# Reads one top-level string field out of a manifest written by backup.sh.
#######################################
manifest_field() {
	sed -n "s/^  \"$2\": \"\([^\"]*\)\",\{0,1\}$/\1/p" "$1" | head -n 1
}
