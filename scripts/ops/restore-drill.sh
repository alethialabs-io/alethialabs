#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Scripted restore of an off-box backup onto a THROWAWAY box, timed, with erasure tombstones
# replayed before the restored console serves (REL-L7, #6908; beta predicate B7, restore drill).
#
#   restore-drill.sh --target drill [--execute] [options]
#   restore-drill.sh --self-test
#
# Without --execute it is a dry run: it checks the box, the tools and the off-box listing, prints
# the plan, and changes nothing. With --execute, on a box that passes every guard, it:
#
#    1  downloads a daily copy (latest by default) and the newest hourly tombstone export
#    2  verifies every file against the manifest's sha256, and decrypts with your age identity
#    3  starts Postgres + SeaweedFS as compose project `alethia-drill`, on a network with NO egress
#    4  pg_restore's the dump, and refuses to go on unless it restored at least one table; loads
#       every bucket back into SeaweedFS
#    5  runs the console's migrate one-shot (the image the backup was taken from, by default)
#    6  merges the newest tombstones in, and replays every one (apps/console/scripts/ops/
#       replay-tombstones.ts) — then refuses to go on unless none is left unreplayed
#    7  starts the console and polls /api/health until its BODY says "healthy"
#    8  writes the B7 evidence record (docs/beta/README.md) and a sanitized log beside it
#    9  tears the drill stack and its volumes down (unless --keep)
#
# The duration in the record runs from the script's start (or --started-at, to include the time it
# took to create the box) to the first healthy readiness answer.
#
# Options
#   --target drill        REQUIRED. The only accepted value. There is no flag that restores onto
#                         production: a real recovery goes through the normal deploy (runbook).
#   --execute             do it. Without this, nothing is changed.
#   --backup STAMP        a daily stamp (YYYYMMDDTHHMMSSZ) instead of the newest complete copy
#   --env-file FILE       BACKUP_S3_* settings (default /etc/alethia/backup.env)
#   --age-identity FILE   the age private key (or AGE_IDENTITY_FILE). Never stored by this script.
#   --image-tag SHA       the console/migrate image to restore with (default: the manifest's
#                         sourceCommit, the build that was running when the backup was taken)
#   --record PATH         where to write the record (default docs/beta/evidence/b7/<date>-restore-drill.md)
#   --no-record           do not write a record
#   --started-at EPOCH    the clock starts here instead of now (must be within the last 24h)
#   --health-timeout S    seconds to wait for a healthy console (default 600)
#   --observer WHO        who ran it, for the record: maintainer (default), agent or cohort. The
#                         weekly automated drill (scripts/ops/restore-drill-ec2.sh) passes agent.
#   --keep                leave the drill stack running afterwards (it holds restored personal data:
#                         take it down and delete the box when you are done)
#
# THIS SCRIPT REFUSES when any of these hold, and has no flag to override them:
#   · the target is not `drill`
#   · the host is named alethia-cp (the production server's name in infra/cp-hetzner/main.tf)
#   · a container or volume of the production compose project (`alethia`) exists on this Docker
#   · /opt/alethia/.env sets TUNNEL_TOKEN (only the production box is wired to the tunnel)
#   · a volume of the drill project already exists (the drill measures an EMPTY box)
#
# Never add `set -x`: this script handles storage keys and decrypted personal data.
#
# SC2016: the single-quoted '$POSTGRES_USER'-style strings expand INSIDE the container, and the
# backticks in the record are Markdown. SC2094: rel_to_repo only rewrites a path string.
# shellcheck disable=SC2016,SC2094

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../deploy/prod/backup/lib.sh source-path=SCRIPTDIR
. "$REPO/deploy/prod/backup/lib.sh"

PROD_PROJECT="${ALETHIA_COMPOSE_PROJECT:-alethia}"
PROD_HOSTNAME="alethia-cp"
PROD_ENV_FILE="${ALETHIA_PROD_ENV_FILE:-/opt/alethia/.env}"
DRILL_PROJECT="alethia-drill"
INSTRUMENT="scripts/ops/restore-drill.sh"

TARGET=""
EXECUTE=0
BACKUP_STAMP=""
ENV_FILE="/etc/alethia/backup.env"
AGE_IDENTITY="${AGE_IDENTITY_FILE:-}"
IMAGE_TAG=""
RECORD=""
WRITE_RECORD=1
STARTED_AT=""
HEALTH_TIMEOUT=600
KEEP=0
OBSERVER="maintainer"
TABLES_RESTORED=""

WORK=""
STACK_UP=0
STEP="start"
LOGFILE=""
T0=0
T_SERVING=0
TOMBSTONES_REPLAYED=false
REPLAY_SUMMARY=""
TOMB_EXPORTED_AT=""
HEALTH_BODY=""

#######################################
# Prints usage (the header comment).
#######################################
usage() {
	sed -n '5,53p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

#######################################
# Logs a step both to stderr and to the sanitized drill log. Callers never pass secrets or data.
#######################################
step() {
	STEP="$1"
	log "[$STEP] $2"
	[ -z "$LOGFILE" ] || printf '%s  [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STEP" "$2" >>"$LOGFILE"
}

#######################################
# The production guards. Prints one line per reason this box must not be restored onto, and
# returns non-zero when there is any. Read-only: docker ps / volume ls, hostname, one grep.
#######################################
production_refusals() {
	local reasons=() h
	[ "$TARGET" = "drill" ] || reasons+=("--target must be 'drill' (got '${TARGET:-nothing}'); there is no production target")
	h="$(hostname 2>/dev/null || true)"
	[ "$h" != "$PROD_HOSTNAME" ] || reasons+=("this host is named $PROD_HOSTNAME, the production server")
	if [ -n "$(docker ps -a -q --filter "label=com.docker.compose.project=$PROD_PROJECT" 2>/dev/null || true)" ]; then
		reasons+=("containers of the production compose project '$PROD_PROJECT' exist on this Docker")
	fi
	if docker volume ls -q 2>/dev/null | grep -Eq "^${PROD_PROJECT}_"; then
		reasons+=("volumes of the production compose project '$PROD_PROJECT' exist on this Docker")
	fi
	if [ -n "$(env_file_value "$PROD_ENV_FILE" TUNNEL_TOKEN)" ]; then
		reasons+=("$PROD_ENV_FILE sets TUNNEL_TOKEN; only the production box is wired to the tunnel")
	fi
	if docker volume ls -q 2>/dev/null | grep -Eq "^${DRILL_PROJECT}_"; then
		reasons+=("volumes of '$DRILL_PROJECT' already exist; a drill measures an empty box (remove them, or use a fresh box)")
	fi
	if [ "${#reasons[@]}" -gt 0 ]; then
		printf '%s\n' "${reasons[@]}"
		return 1
	fi
}

#######################################
# Parses arguments.
#######################################
parse_args() {
	while [ $# -gt 0 ]; do
		case "$1" in
			--target) TARGET="${2:-}"; shift 2 ;;
			--execute) EXECUTE=1; shift ;;
			--backup) BACKUP_STAMP="${2:-}"; shift 2 ;;
			--env-file) ENV_FILE="${2:-}"; shift 2 ;;
			--age-identity) AGE_IDENTITY="${2:-}"; shift 2 ;;
			--image-tag) IMAGE_TAG="${2:-}"; shift 2 ;;
			--record) RECORD="${2:-}"; shift 2 ;;
			--no-record) WRITE_RECORD=0; shift ;;
			--started-at) STARTED_AT="${2:-}"; shift 2 ;;
			--health-timeout) HEALTH_TIMEOUT="${2:-}"; shift 2 ;;
			--keep) KEEP=1; shift ;;
			--observer) OBSERVER="${2:-}"; shift 2 ;;
			-h | --help) usage; exit 0 ;;
			*) usage >&2; die "unknown argument: $1" 64 ;;
		esac
	done
	[ -z "$BACKUP_STAMP" ] || [[ "$BACKUP_STAMP" =~ $BACKUP_STAMP_RE ]] || die "--backup must be a stamp like 20261201T023000Z" 64
	[ -z "$IMAGE_TAG" ] || [[ "$IMAGE_TAG" =~ ^[0-9a-f]{40}$ ]] || die "--image-tag must be a full 40-character commit SHA" 64
	[[ "$HEALTH_TIMEOUT" =~ ^[0-9]+$ ]] || die "--health-timeout must be whole seconds" 64
	# The record's observer enum (docs/beta/evidence-schema.json).
	case "$OBSERVER" in agent | maintainer | cohort) ;; *) die "--observer must be agent, maintainer or cohort" 64 ;; esac
	if [ -n "$STARTED_AT" ]; then
		local now
		now="$(date -u +%s)"
		[[ "$STARTED_AT" =~ ^[0-9]+$ ]] && [ "$STARTED_AT" -le "$now" ] && [ $((now - STARTED_AT)) -le 86400 ] ||
			die "--started-at must be epoch seconds within the last 24 hours" 64
	fi
}

#######################################
# Loads the BACKUP_S3_* settings from the env file, without sourcing it.
#######################################
load_backup_env() {
	[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE (pass --env-file)"
	local k
	for k in BACKUP_S3_ENDPOINT BACKUP_S3_REGION BACKUP_S3_PROVIDER BACKUP_S3_BUCKET \
		BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY BACKUP_PREFIX BACKUP_RCLONE_IMAGE; do
		if [ -z "${!k:-}" ]; then
			printf -v "$k" '%s' "$(env_file_value "$ENV_FILE" "$k")"
		fi
	done
	BACKUP_PREFIX="${BACKUP_PREFIX:-alethia-prod}"
	BACKUP_RCLONE_IMAGE="${BACKUP_RCLONE_IMAGE:-rclone/rclone:1.68.2}"
	require_env BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
}

#######################################
# Runs docker compose for the drill project, with the drill env and the no-egress override.
#######################################
dc() {
	docker compose -p "$DRILL_PROJECT" --project-directory "$REPO" \
		--env-file "$WORK/drill.env" \
		-f "$REPO/docker-compose.yml" -f "$REPO/deploy/prod/docker-compose.prod.yml" \
		-f "$WORK/drill.override.yml" "$@"
}

#######################################
# Runs SQL in the drill Postgres as its superuser; extra args go to psql.
#######################################
drill_psql() {
	dc exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -X -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' psql "$@"
}

#######################################
# Writes drill.env (from .env.example, as a fresh box's cloud-init does, with drill-only random
# passwords) and the compose override that cuts the drill network off from the internet.
#######################################
write_drill_config() {
	(umask 077 && cp "$REPO/.env.example" "$WORK/drill.env")
	env_file_set "$WORK/drill.env" ALETHIA_DB_USER alethia
	env_file_set "$WORK/drill.env" ALETHIA_DB_NAME alethia
	env_file_set "$WORK/drill.env" ALETHIA_DB_PASSWORD "$(random_hex)"
	env_file_set "$WORK/drill.env" ALETHIA_APP_DB_PASSWORD "$(random_hex)"
	env_file_set "$WORK/drill.env" BETTER_AUTH_SECRET "$(random_hex)"
	env_file_set "$WORK/drill.env" ALETHIA_IMAGE_TAG "$IMAGE_TAG"
	env_file_set "$WORK/drill.env" ALETHIA_DOMAIN ""
	# Every other required instance secret gets a drill-only value from its manifest generator:
	# docker-compose.yml refuses to render while one is empty. In a subshell, so the helpers stay
	# out of this script's namespace.
	(
		SECRETS_MANIFEST="$REPO/deploy/selfhost/secrets.manifest"
		# shellcheck source=SCRIPTDIR/../../deploy/selfhost/secrets.sh
		. "$REPO/deploy/selfhost/secrets.sh"
		fill_required_secrets "$WORK/drill.env" >/dev/null
	) || die "could not generate the drill's instance secrets"
	# The restored database still holds production's encrypted credentials. The drill does not get
	# production's key (its ALETHIA_CRED_ENCRYPTION_KEY is the drill-only one generated above), so
	# they stay ciphertext here; nothing on a drill box can decrypt them.
	cat >"$WORK/drill.override.yml" <<-YAML
		# Written by $INSTRUMENT. The drill network has no route out: a restored console must not
		# send a notification, call a webhook, or reach a customer's cloud on production's behalf.
		networks:
		  default:
		    internal: true
		services:
		  app:
		    env_file: !override
		      - $WORK/drill.env
		  marketing:
		    env_file: !override
		      - $WORK/drill.env
		  admin:
		    env_file: !override
		      - $WORK/drill.env
	YAML
}

#######################################
# Writes the evidence record and its sanitized log. Called on success and on failure.
#######################################
write_record() {
	local verdict="$1" note="$2" now date_day duration="" path log_rel
	[ "$WRITE_RECORD" -eq 1 ] || return 0
	[[ "$IMAGE_TAG" =~ ^[0-9a-f]{40}$ ]] || { log "no 40-character build SHA known; no record written"; return 0; }
	now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	date_day="${now%%T*}"
	path="${RECORD:-$REPO/docs/beta/evidence/b7/${date_day}-restore-drill.md}"
	if [ -e "$path" ]; then
		path="${path%.md}-$(date -u +%H%M%S).md"
	fi
	mkdir -p "$(dirname "$path")"
	log_rel="$(basename "${path%.md}").log"
	[ "$T_SERVING" -gt 0 ] && duration=$((T_SERVING - T0))
	cp "$LOGFILE" "$(dirname "$path")/$log_rel"
	{
		printf -- '---\n'
		printf 'schemaVersion: 1\n'
		printf 'predicate: B7\n'
		printf 'cloud: all\n'
		printf 'date: "%s"\n' "$now"
		printf 'buildSha: "%s"\n' "$IMAGE_TAG"
		printf 'verdict: %s\n' "$verdict"
		printf 'instrument: %s\n' "$INSTRUMENT"
		printf 'observer: %s\n' "$OBSERVER"
		printf 'check: restore-drill\n'
		printf 'tombstonesReplayed: %s\n' "$TOMBSTONES_REPLAYED"
		[ -z "$duration" ] || printf 'durationSeconds: %s\n' "$duration"
		if [ "$verdict" = pass ]; then
			printf 'evidence:\n'
			printf '  - %s\n' "$(rel_to_repo "$(dirname "$path")/$log_rel")"
			printf '  - %s\n' "$INSTRUMENT"
			printf '  - docs/ops/restore-runbook.md\n'
		fi
		printf -- '---\n\n'
		printf '# B7 restore drill — %s\n\n' "$date_day"
		printf -- '- Backup restored: daily `%s` (manifest finishedAt %s)\n' "$BACKUP_STAMP" "${MANIFEST_FINISHED:-unknown}"
		printf -- '- Console image: `%s`\n' "$IMAGE_TAG"
		printf -- '- Tables restored from the dump: %s\n' "${TABLES_RESTORED:-not reached}"
		printf -- '- Newest tombstone export merged: %s\n' "${TOMB_EXPORTED_AT:-none found}"
		printf -- '- Tombstone replay: `%s`\n' "${REPLAY_SUMMARY:-not reached}"
		printf -- '- Readiness body: `%s`\n' "${HEALTH_BODY:-not reached}"
		printf -- '- Clock: started %s, serving %s%s\n' "$(iso_of "$T0")" \
			"$( [ "$T_SERVING" -gt 0 ] && iso_of "$T_SERVING" || printf 'never')" \
			"$( [ -n "$STARTED_AT" ] && printf ' (clock started by --started-at, before the script)' || true)"
		printf -- '- Outcome: %s\n\n' "$note"
		printf 'Steps, in order, are in [`%s`](%s). Commit both files.\n' "$log_rel" "$log_rel"
	} >"$path"
	log "record written: $path"
}

#######################################
# Succeeds when a psql table count is a positive whole number. Pure, so --self-test holds it.
#######################################
restored_tables_ok() {
	[[ "${1:-}" =~ ^[0-9]+$ ]] && [ "$1" -gt 0 ]
}

#######################################
# Prints a path relative to the repository root.
#######################################
rel_to_repo() {
	local p="$1"
	case "$p" in "$REPO"/*) printf '%s' "${p#"$REPO"/}" ;; *) printf '%s' "$p" ;; esac
}

#######################################
# Prints the RFC 3339 UTC form of epoch seconds, on GNU or BSD date.
#######################################
iso_of() {
	date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ
}

#######################################
# On any exit: record a failure if the drill did not finish, tear down, remove decrypted files.
#######################################
on_exit() {
	local rc=$?
	trap - EXIT
	if [ "$EXECUTE" -eq 1 ] && [ "$rc" -ne 0 ] && [ -n "$LOGFILE" ]; then
		step "$STEP" "FAILED (exit $rc)"
		write_record fail "failed at step '$STEP' (exit $rc)" || true
	fi
	if [ "$STACK_UP" -eq 1 ] && [ "$KEEP" -eq 0 ]; then
		log "tearing down the drill stack and its volumes"
		dc down -v --remove-orphans >/dev/null 2>&1 || log "teardown failed: run 'docker compose -p $DRILL_PROJECT down -v' by hand"
	fi
	if [ -n "$WORK" ] && [ -d "$WORK" ]; then
		if [ "$STACK_UP" -eq 1 ] && [ "$KEEP" -eq 1 ]; then
			# The compose files still point into WORK; keep only the config, drop the data.
			rm -rf "$WORK/in" "$WORK/plain" "$WORK/offbox.env"
			log "kept the drill stack; its config is in $WORK. It holds restored personal data."
		else
			rm -rf "$WORK"
		fi
	fi
	exit "$rc"
}

#######################################
# The drill.
#######################################
run_drill() {
	T0="${STARTED_AT:-$(date -u +%s)}"
	WORK="$(secret_dir "${BACKUP_WORKDIR:-/var/tmp}")"
	LOGFILE="$WORK/drill.log"
	: >"$LOGFILE"
	mkdir -p "$WORK/in" "$WORK/plain"
	local envf
	envf="$(offbox_env_file "$WORK")"

	# 1. Fetch.
	step fetch "resolving the backup"
	if [ -z "$BACKUP_STAMP" ]; then
		rclone_run - "$envf" "$WORK" copyto "$(offbox_path latest.json)" /work/in/latest.json
		BACKUP_STAMP="$(manifest_field "$WORK/in/latest.json" stamp)"
		[[ "$BACKUP_STAMP" =~ $BACKUP_STAMP_RE ]] || die "latest.json names no valid stamp"
	fi
	step fetch "downloading daily/$BACKUP_STAMP and the newest tombstone export"
	rclone_run - "$envf" "$WORK" copy "$(offbox_path "daily/$BACKUP_STAMP")" /work/in/daily
	[ -s "$WORK/in/daily/$BACKUP_FILE_MANIFEST" ] || die "daily/$BACKUP_STAMP has no manifest: it is not a complete copy"
	rclone_run - "$envf" "$WORK" copy "$(offbox_path tombstones)" /work/in/tombstones || true
	MANIFEST_FINISHED="$(manifest_field "$WORK/in/daily/$BACKUP_FILE_MANIFEST" finishedAt)"
	if [ -z "$IMAGE_TAG" ]; then
		IMAGE_TAG="$(manifest_field "$WORK/in/daily/$BACKUP_FILE_MANIFEST" sourceCommit)"
		[[ "$IMAGE_TAG" =~ ^[0-9a-f]{40}$ ]] || die "the manifest names no build SHA; pass --image-tag"
	fi

	# 2. Verify, then decrypt.
	step verify "checking sha256 of every file against the manifest"
	local f want got
	for f in "$BACKUP_FILE_DUMP" "$BACKUP_FILE_STORAGE" "$BACKUP_FILE_TOMBSTONES"; do
		want="$(manifest_sha256 "$WORK/in/daily/$BACKUP_FILE_MANIFEST" "$f")"
		[ -n "$want" ] || die "the manifest has no sha256 for $f"
		got="$(sha256_of "$WORK/in/daily/$f")"
		[ "$want" = "$got" ] || die "$f does not match its manifest hash"
	done
	if [ -s "$WORK/in/tombstones/latest.json" ]; then
		want="$(manifest_field "$WORK/in/tombstones/latest.json" sha256)"
		got="$(sha256_of "$WORK/in/tombstones/latest.csv.age")"
		[ "$want" = "$got" ] || die "tombstones/latest.csv.age does not match its hash"
		TOMB_EXPORTED_AT="$(manifest_field "$WORK/in/tombstones/latest.json" exportedAt)"
	fi
	step decrypt "decrypting with the age identity"
	age -d -i "$AGE_IDENTITY" -o "$WORK/plain/postgres.dump" "$WORK/in/daily/$BACKUP_FILE_DUMP"
	age -d -i "$AGE_IDENTITY" -o "$WORK/plain/tombstones.daily.csv" "$WORK/in/daily/$BACKUP_FILE_TOMBSTONES"
	if [ -s "$WORK/in/tombstones/latest.csv.age" ]; then
		age -d -i "$AGE_IDENTITY" -o "$WORK/plain/tombstones.latest.csv" "$WORK/in/tombstones/latest.csv.age"
	fi
	mkdir -p "$WORK/plain/storage"
	age -d -i "$AGE_IDENTITY" "$WORK/in/daily/$BACKUP_FILE_STORAGE" | gzip -dc | tar -C "$WORK/plain/storage" -xf -
	rm -rf "$WORK/in/daily"

	# 3. Datastores, on the no-egress network.
	step datastores "starting postgres and seaweedfs as project $DRILL_PROJECT (image $IMAGE_TAG)"
	write_drill_config
	STACK_UP=1
	dc pull --quiet postgres seaweedfs migrate app
	dc up -d --wait postgres seaweedfs

	# 4. Data.
	step restore "pg_restore into an empty database"
	# The app role must exist before the dump's RLS policies name it; migrate sets its password.
	drill_psql -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alethia_app') THEN CREATE ROLE alethia_app NOLOGIN; END IF; END \$\$;"
	# --no-owner/--no-privileges: production's role names need not exist here; migrate re-applies
	# every grant from programmables.sql in step 5.
	dc exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error' \
		<"$WORK/plain/postgres.dump"
	rm -f "$WORK/plain/postgres.dump"
	# Counted BEFORE migrate, which would create the schema on an empty database and hide a dump
	# that restored nothing. A count, never a row: the record carries no personal data.
	TABLES_RESTORED="$(drill_psql -A -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'" | tr -d '[:space:]')"
	restored_tables_ok "$TABLES_RESTORED" || die "the dump restored no tables (count: '${TABLES_RESTORED:-none}')"
	step restore "restored $TABLES_RESTORED tables"
	step restore "loading buckets into seaweedfs"
	local net ak sk
	net="$(container_network "$(compose_container "$DRILL_PROJECT" seaweedfs)")"
	ak="$(env_file_value "$WORK/drill.env" ALETHIA_STORAGE_ACCESS_KEY_ID)"
	sk="$(env_file_value "$WORK/drill.env" ALETHIA_STORAGE_SECRET_ACCESS_KEY)"
	(
		umask 077
		printf 'RCLONE_CONFIG_DST_TYPE=s3\nRCLONE_CONFIG_DST_PROVIDER=SeaweedFS\nRCLONE_CONFIG_DST_ENDPOINT=http://seaweedfs:8333\n' >"$WORK/dst.env"
		printf 'RCLONE_CONFIG_DST_ACCESS_KEY_ID=%s\nRCLONE_CONFIG_DST_SECRET_ACCESS_KEY=%s\n' "$ak" "$sk" >>"$WORK/dst.env"
	)
	rclone_run "$net" "$WORK/dst.env" "$WORK" copy /work/plain/storage DST: --metadata
	rm -rf "$WORK/plain/storage"

	# 5. Migrate: the restored schema is brought to the image's, and grants/RLS re-applied.
	step migrate "running the migrate one-shot"
	dc run --rm --no-deps migrate

	# 6. Tombstones: merge the newest export in, mark all as not yet replayed HERE, replay, check.
	step tombstones "merging tombstone exports"
	local csv
	for csv in "$WORK/plain/tombstones.daily.csv" "$WORK/plain/tombstones.latest.csv"; do
		[ -s "$csv" ] || continue
		drill_psql -1 \
			-c "CREATE TEMP TABLE tomb_in (LIKE privacy_erasure_tombstone INCLUDING DEFAULTS)" \
			-c "\\copy tomb_in ($BACKUP_TOMBSTONE_COLUMNS) FROM pstdin WITH (FORMAT csv, HEADER true)" \
			-c "INSERT INTO privacy_erasure_tombstone ($BACKUP_TOMBSTONE_COLUMNS) SELECT $BACKUP_TOMBSTONE_COLUMNS FROM tomb_in ON CONFLICT (id) DO NOTHING" \
			<"$csv"
	done
	# A replayed_at carried in from production (or an earlier restore) says nothing about THIS one.
	drill_psql -c "UPDATE privacy_erasure_tombstone SET replayed_at = NULL"
	step tombstones "replaying every tombstone before the console serves"
	local replay=(./node_modules/.bin/tsx scripts/ops/replay-tombstones.ts)
	local mount=()
	if ! dc run --rm --no-deps --entrypoint test migrate -f scripts/ops/replay-tombstones.ts >/dev/null 2>&1; then
		# An image older than this script: run this checkout's copy against the image's register.
		mount=(-v "$REPO/apps/console/scripts/ops/replay-tombstones.ts:/app/apps/console/scripts/ops/replay-tombstones.ts:ro")
		step tombstones "image predates replay-tombstones.ts; mounting this checkout's copy"
	fi
	REPLAY_SUMMARY="$(dc run --rm --no-deps "${mount[@]}" -e NODE_PATH=scripts/e2e/node-stubs migrate "${replay[@]}" --apply | tail -n 1)"
	step tombstones "replay: $REPLAY_SUMMARY"
	dc run --rm --no-deps "${mount[@]}" -e NODE_PATH=scripts/e2e/node-stubs migrate "${replay[@]}" --check >/dev/null ||
		die "tombstones remain unreplayed; the console is not started"
	TOMBSTONES_REPLAYED=true

	# 7. Serve, and read the readiness BODY, not the status code.
	step serve "starting the console"
	dc up -d --no-deps app
	local deadline=$(($(date -u +%s) + HEALTH_TIMEOUT)) body status
	while :; do
		body="$(dc exec -T app wget -q -O - http://127.0.0.1:3000/api/health 2>/dev/null || true)"
		status="$(printf '%s' "$body" | sed -n 's/.*"status":"\([a-z]*\)".*/\1/p' | head -n 1)"
		if [ "$status" = healthy ]; then
			T_SERVING="$(date -u +%s)"
			HEALTH_BODY="$body"
			break
		fi
		[ "$(date -u +%s)" -lt "$deadline" ] || { HEALTH_BODY="$body"; die "no healthy readiness answer within ${HEALTH_TIMEOUT}s (last status: ${status:-none})"; }
		sleep 5
	done
	step serve "console healthy after $((T_SERVING - T0))s"

	write_record pass "restored, replayed and serving in $((T_SERVING - T0))s"
}

#######################################
# Hermetic self-test: the guards and the dry run, against a fake docker and hostname on PATH.
# Every assertion feeds the exit code.
#######################################
self_test() {
	local fails=0 tmp out rc
	tmp="$(secret_dir)"
	WORK="$tmp"
	mkdir -p "$tmp/bin"
	# A fake docker: `ps` and `volume ls` answer from files the scenario writes; anything else fails
	# the test loudly, so a dry run that tried to change something would be caught.
	cat >"$tmp/bin/docker" <<-'SH'
		#!/usr/bin/env bash
		case "$1 $2" in
		  "ps -a") cat "$FAKE/ps" 2>/dev/null; exit 0 ;;
		  "volume ls") cat "$FAKE/volumes" 2>/dev/null; exit 0 ;;
		  *) echo "fake docker: unexpected call: $*" >&2; echo "$*" >>"$FAKE/unexpected"; exit 99 ;;
		esac
	SH
	printf '#!/bin/sh\ncat "$FAKE/hostname"\n' >"$tmp/bin/hostname"
	chmod +x "$tmp/bin/docker" "$tmp/bin/hostname"
	printf 'BACKUP_S3_ENDPOINT=https://s3.example.invalid\nBACKUP_S3_BUCKET=b\nBACKUP_S3_ACCESS_KEY_ID=k\nBACKUP_S3_SECRET_ACCESS_KEY=s\n' >"$tmp/backup.env"

	expect() { # expect <name> <want-rc> <want-substring> -- args…
		local name="$1" want_rc="$2" want_text="$3"
		shift 4
		rc=0
		out="$(FAKE="$tmp/scenario" PATH="$tmp/bin:$PATH" ALETHIA_PROD_ENV_FILE="$tmp/scenario/prod.env" \
			bash "${BASH_SOURCE[0]}" "$@" 2>&1)" || rc=$?
		if [ "$rc" = "$want_rc" ] && [[ "$out" == *"$want_text"* ]] && [ ! -e "$tmp/scenario/unexpected" ]; then
			printf 'ok    %s\n' "$name"
		else
			printf 'FAIL  %s (rc %s, want %s)\n%s\n' "$name" "$rc" "$want_rc" "$(printf '%s' "$out" | sed 's/^/      /')"
			[ ! -e "$tmp/scenario/unexpected" ] || printf '      unexpected docker calls: %s\n' "$(cat "$tmp/scenario/unexpected")"
			fails=$((fails + 1))
		fi
	}
	scenario() { # scenario <hostname> <ps-output> <volumes-output> <prod-env-line>
		rm -rf "$tmp/scenario"
		mkdir -p "$tmp/scenario"
		printf '%s\n' "$1" >"$tmp/scenario/hostname"
		[ -z "$2" ] || printf '%s\n' "$2" >"$tmp/scenario/ps"
		[ -z "$3" ] || printf '%s\n' "$3" >"$tmp/scenario/volumes"
		[ -z "$4" ] || printf '%s\n' "$4" >"$tmp/scenario/prod.env"
	}

	scenario drill-box "" "" ""
	expect "no --target is refused" 3 "--target must be 'drill'" -- --env-file "$tmp/backup.env"
	expect "--target production is refused" 3 "there is no production target" -- --target production --env-file "$tmp/backup.env"
	expect "a clean drill box dry-runs and changes nothing" 0 "DRY RUN" -- --target drill --env-file "$tmp/backup.env"
	expect "a dry run with --execute absent never needs an identity" 0 "would decrypt" -- --target drill --env-file "$tmp/backup.env"

	scenario alethia-cp "" "" ""
	expect "the production hostname is refused" 3 "the production server" -- --target drill --env-file "$tmp/backup.env" --execute

	scenario drill-box "abc123" "" ""
	expect "a production-project container is refused" 3 "containers of the production compose project" -- --target drill --env-file "$tmp/backup.env" --execute

	scenario drill-box "" "alethia_postgres-data" ""
	expect "a production-project volume is refused" 3 "volumes of the production compose project" -- --target drill --env-file "$tmp/backup.env" --execute

	scenario drill-box "" "" "TUNNEL_TOKEN=eyJhIjoi"
	expect "a tunnel-wired .env is refused" 3 "sets TUNNEL_TOKEN" -- --target drill --env-file "$tmp/backup.env" --execute

	scenario drill-box "" "alethia-drill_postgres-data" ""
	expect "a box with a previous drill's volumes is refused" 3 "a drill measures an empty box" -- --target drill --env-file "$tmp/backup.env" --execute

	scenario drill-box "" "" "TUNNEL_TOKEN="
	expect "an empty TUNNEL_TOKEN is not the production box" 0 "DRY RUN" -- --target drill --env-file "$tmp/backup.env"

	scenario drill-box "" "" ""
	expect "--execute without an identity is refused before anything runs" 64 "age identity" -- --target drill --env-file "$tmp/backup.env" --execute
	expect "a malformed --backup is refused" 64 "--backup must be a stamp" -- --target drill --backup latest-ish
	expect "a short --image-tag is refused" 64 "full 40-character" -- --target drill --image-tag abc123
	expect "--started-at in the future is refused" 64 "--started-at" -- --target drill --started-at 9999999999
	expect "an --observer outside the record's enum is refused" 64 "--observer must be" -- --target drill --observer robot
	expect "--observer agent dry-runs" 0 "DRY RUN" -- --target drill --env-file "$tmp/backup.env" --observer agent

	# The restored-table check, in-process: a count of zero, nothing, or psql noise is a failed restore.
	local c
	for c in 1 57; do
		if restored_tables_ok "$c"; then printf 'ok    table count %s passes\n' "$c"; else printf 'FAIL  table count %s should pass\n' "$c"; fails=$((fails + 1)); fi
	done
	for c in 0 "" "ERROR" "-3"; do
		if restored_tables_ok "$c"; then printf "FAIL  table count '%s' should fail\n" "$c"; fails=$((fails + 1)); else printf "ok    table count '%s' fails\n" "$c"; fi
	done

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
	if [ "${1:-}" = "--self-test" ]; then
		trap 'rm -rf "${WORK:-/nonexistent}"' EXIT
		self_test
		return
	fi
	parse_args "$@"
	require_cmd docker
	local refusals
	if ! refusals="$(production_refusals)"; then
		printf 'REFUSED — this box must not be restored onto:\n' >&2
		printf '  · %s\n' "${refusals//$'\n'/$'\n  · '}" >&2
		exit 3
	fi
	load_backup_env

	if [ "$EXECUTE" -eq 0 ]; then
		local p_backup="${BACKUP_STAMP:-the newest complete daily, from latest.json}"
		local p_image="${IMAGE_TAG:-the build named in the manifest (sourceCommit)}"
		local p_ident="${AGE_IDENTITY:-an identity from --age-identity, required with --execute}"
		local p_record="${RECORD:-docs/beta/evidence/b7/DATE-restore-drill.md}"
		local p_after="stack and volumes removed"
		[ "$WRITE_RECORD" -eq 1 ] || p_record="none (--no-record)"
		[ "$KEEP" -eq 0 ] || p_after="stack kept running"
		printf 'DRY RUN — nothing will be changed. Re-run with --execute to restore.\n'
		printf '  %-15s %s\n' \
			target "drill (compose project $DRILL_PROJECT, network without egress)" \
			backup "$p_backup at $(offbox_path "")" \
			image "$p_image" \
			"would decrypt" "with $p_ident" \
			"would replay" "every erasure tombstone before the console starts" \
			record "$p_record" \
			afterwards "$p_after"
		return 0
	fi

	[ -n "$AGE_IDENTITY" ] && [ -r "$AGE_IDENTITY" ] || die "--execute needs a readable age identity (--age-identity FILE or AGE_IDENTITY_FILE)" 64
	require_cmd age gzip tar
	trap on_exit EXIT
	run_drill
}

main "$@"
