#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Off-box backup of the production box (REL-L7, #6908; beta predicate B7).
#
#   backup.sh run          nightly: logical Postgres dump + a copy of every SeaweedFS bucket (tofu
#                          state and plan artefacts) + the erasure tombstones, each encrypted with
#                          age to the public recipients in BACKUP_AGE_RECIPIENTS, uploaded to an
#                          S3-compatible store at a second provider; then retention: 14 dailies and
#                          8 weeklies, deleted here (BACKUP_RETENTION=script) or by the bucket (=bucket).
#   backup.sh tombstones   hourly: the erasure tombstones alone, to tombstones/latest.*. See below.
#   backup.sh status       B7's listing: the newest COMPLETE copy and its age. Exit 0 when it is
#                          younger than BACKUP_MAX_AGE_HOURS (26), 1 when older, 2 when unreadable.
#   backup.sh --self-test  hermetic checks of the pure parts; touches no docker, no network.
#
# Runs ON the production box, as root (it needs the docker socket), from the systemd units next to
# this file. Configuration and credentials come from the environment, which the units load from
# /etc/alethia/backup.env (0600, outside the repository; see backup.env.example). Nothing here is a
# secret default, and nothing is printed that is one.
#
# WHAT IT READS FROM THE BOX
#   Postgres   `pg_dump -Fc` inside the running postgres container, as the container's own superuser
#              over its local socket — so no database password crosses into this script at all. The
#              dump streams straight into age; the plaintext never touches a disk.
#   SeaweedFS  every bucket, through an rclone container on the compose network (SeaweedFS is not
#              published to the host). The storage keys are read from $ALETHIA_DIR/.env, which the
#              deploy writes from the vault, without sourcing that file.
#   Tombstones `privacy_erasure_tombstone`, as CSV, so a restore of an OLDER dump can still replay
#              erasures that happened after it was taken (the dump cannot carry those; that is the
#              whole reason the hourly export exists).
#
# THE LAYOUT OFF-BOX, under <bucket>/<BACKUP_PREFIX>/
#   daily/<stamp>/{postgres.dump.age, storage.tar.gz.age, tombstones.csv.age, manifest.json}
#   weekly/<YYYY-Www>/…        the first complete daily of each ISO week, uploaded a second time
#   latest.json                names the newest complete daily; written after its manifest
#   tombstones/latest.csv.age  + tombstones/latest.json, rewritten every hour
# A daily directory without manifest.json did not finish and is never read as a backup.
#
# RETENTION (BACKUP_RETENTION, see retention_mode in lib.sh)
#   script     the default: after a complete night, `rclone purge` removes the copies beyond
#              BACKUP_KEEP_DAILY / BACKUP_KEEP_WEEKLY. The box key needs delete.
#   bucket     production: this script never deletes, overwrites only the two pointers, and makes
#              every upload multipart so an Object Lock bucket accepts it. Expiry is the bucket's
#              lifecycle rules; immutability is its Object Lock default retention. The box key has
#              no delete, so whoever holds the box cannot shorten the history.
#
# Never add `set -x`: this script holds storage keys.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$HERE/lib.sh"

ALETHIA_DIR="${ALETHIA_DIR:-/opt/alethia}"
ALETHIA_COMPOSE_PROJECT="${ALETHIA_COMPOSE_PROJECT:-alethia}"
BACKUP_PREFIX="${BACKUP_PREFIX:-alethia-prod}"
BACKUP_KEEP_DAILY="${BACKUP_KEEP_DAILY:-14}"
BACKUP_KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-8}"
BACKUP_RETENTION="${BACKUP_RETENTION:-script}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"
BACKUP_LOCK="${BACKUP_LOCK:-/run/lock/alethia-backup.lock}"

WORK=""

#######################################
# Removes the working directory (plaintext bucket copies, the rclone env file) on any exit.
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
	sed -n '5,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

#######################################
# Takes the backup lock, so the nightly and the hourly never write the same object at once.
#######################################
take_lock() {
	require_cmd flock
	exec 9>"$BACKUP_LOCK"
	flock -w 1800 9 || die "another backup run has held $BACKUP_LOCK for 30 minutes"
}

#######################################
# Prints the running postgres container's id, or exits.
#######################################
postgres_container() {
	local id
	id="$(compose_container "$ALETHIA_COMPOSE_PROJECT" postgres)"
	[ -n "$id" ] || die "no postgres container for compose project '$ALETHIA_COMPOSE_PROJECT' on this box"
	printf '%s' "$id"
}

#######################################
# Streams the tombstone table as CSV (header first) into age, writing OUT.
#######################################
export_tombstones() {
	local pg="$1" out="$2"
	local -a rcpt
	mapfile -t rcpt < <(age_recipient_args)
	docker exec -i "$pg" sh -c \
		"psql -v ON_ERROR_STOP=1 -X -q -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"\\copy (SELECT $BACKUP_TOMBSTONE_COLUMNS FROM privacy_erasure_tombstone ORDER BY erased_at, id) TO STDOUT WITH (FORMAT csv, HEADER true)\"" |
		age "${rcpt[@]}" -o "$out"
}

#######################################
# Counts the data rows in the tombstone table (the CSV has one more line: the header).
#######################################
count_tombstones() {
	docker exec -i "$1" sh -c \
		'psql -X -q -t -A -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM privacy_erasure_tombstone"' |
		tr -d '[:space:]'
}

#######################################
# The hourly: export the tombstones alone and replace tombstones/latest.*.
#######################################
cmd_tombstones() {
	require_cmd docker age
	require_env BACKUP_AGE_RECIPIENTS
	take_lock
	WORK="$(secret_dir "${BACKUP_WORKDIR:-}")"
	local envf pg now rows sha
	envf="$(offbox_env_file "$WORK")"
	pg="$(postgres_container)"
	now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	mkdir -p "$WORK/out"
	rows="$(count_tombstones "$pg")"
	[[ "$rows" =~ ^[0-9]+$ ]] || die "could not count privacy_erasure_tombstone rows"
	export_tombstones "$pg" "$WORK/out/latest.csv.age"
	sha="$(sha256_of "$WORK/out/latest.csv.age")"
	printf '{\n  "schemaVersion": 1,\n  "exportedAt": "%s",\n  "rows": %s,\n  "sha256": "%s"\n}\n' \
		"$now" "$rows" "$sha" >"$WORK/out/latest.json"
	rclone_run - "$envf" "$WORK" copyto /work/out/latest.csv.age "$(offbox_path tombstones/latest.csv.age)"
	rclone_run - "$envf" "$WORK" copyto /work/out/latest.json "$(offbox_path tombstones/latest.json)"
	log "tombstones exported off-box: $rows row(s) at $now"
}

#######################################
# The nightly.
#######################################
cmd_run() {
	require_cmd docker age tar gzip
	require_env BACKUP_AGE_RECIPIENTS
	retention_mode >/dev/null # a mistyped mode stops here, before the dump
	take_lock
	WORK="$(secret_dir "${BACKUP_WORKDIR:-}")"
	local envf pg sw net stamp started finished week source_commit pg_major rows
	local -a rcpt
	mapfile -t rcpt < <(age_recipient_args)
	envf="$(offbox_env_file "$WORK")"
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	week="$(date -u +%G-W%V)"
	mkdir -p "$WORK/out" "$WORK/storage"

	pg="$(postgres_container)"
	pg_major="$(docker exec "$pg" sh -c 'pg_dump --version' | sed -n 's/.* \([0-9][0-9]*\)\..*/\1/p' | head -n 1)"
	source_commit="$(container_source_commit "$(compose_container "$ALETHIA_COMPOSE_PROJECT" app)" 2>/dev/null || true)"

	# 1. Postgres. -Fc is pg_restore's input; it also compresses. Streamed into age.
	log "dumping postgres (stamp $stamp)"
	docker exec -i "$pg" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' |
		age "${rcpt[@]}" -o "$WORK/out/$BACKUP_FILE_DUMP"
	[ -s "$WORK/out/$BACKUP_FILE_DUMP" ] || die "the postgres dump is empty"

	# 2. Tombstones, inside the daily too, so a daily is complete on its own.
	rows="$(count_tombstones "$pg")"
	[[ "$rows" =~ ^[0-9]+$ ]] || die "could not count privacy_erasure_tombstone rows"
	export_tombstones "$pg" "$WORK/out/$BACKUP_FILE_TOMBSTONES"

	# 3. SeaweedFS: every bucket, through the compose network.
	sw="$(compose_container "$ALETHIA_COMPOSE_PROJECT" seaweedfs)"
	[ -n "$sw" ] || die "no seaweedfs container for compose project '$ALETHIA_COMPOSE_PROJECT'"
	net="$(container_network "$sw")"
	[ -n "$net" ] || die "could not find the seaweedfs container's network"
	local ak sk
	ak="$(env_file_value "$ALETHIA_DIR/.env" ALETHIA_STORAGE_ACCESS_KEY_ID)"
	sk="$(env_file_value "$ALETHIA_DIR/.env" ALETHIA_STORAGE_SECRET_ACCESS_KEY)"
	[ -n "$ak" ] && [ -n "$sk" ] || die "ALETHIA_STORAGE_ACCESS_KEY_ID / _SECRET_ACCESS_KEY not found in $ALETHIA_DIR/.env"
	(
		umask 077
		{
			printf 'RCLONE_CONFIG_SRC_TYPE=s3\nRCLONE_CONFIG_SRC_PROVIDER=SeaweedFS\n'
			printf 'RCLONE_CONFIG_SRC_ENDPOINT=http://seaweedfs:8333\n'
			printf 'RCLONE_CONFIG_SRC_ACCESS_KEY_ID=%s\nRCLONE_CONFIG_SRC_SECRET_ACCESS_KEY=%s\n' "$ak" "$sk"
		} >"$WORK/src.env"
	)
	log "copying seaweedfs buckets"
	rclone_run "$net" "$WORK/src.env" "$WORK" lsf --dirs-only SRC: >"$WORK/buckets.txt"
	rclone_run "$net" "$WORK/src.env" "$WORK" copy SRC: /work/storage --metadata
	tar -C "$WORK/storage" -cf - . | gzip -6 | age "${rcpt[@]}" -o "$WORK/out/$BACKUP_FILE_STORAGE"
	rm -rf "$WORK/storage"

	# 4. The manifest: what is in this copy, and the hash of every file in it.
	finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	local buckets_json f entries=""
	buckets_json="$(sed 's#/$##' "$WORK/buckets.txt" | awk 'NF { printf "%s\"%s\"", (n++ ? ", " : ""), $0 }')"
	for f in "$BACKUP_FILE_DUMP" "$BACKUP_FILE_STORAGE" "$BACKUP_FILE_TOMBSTONES"; do
		entries="$entries$(printf '    "%s": {"bytes": %s, "sha256": "%s"}' "$f" "$(bytes_of "$WORK/out/$f")" "$(sha256_of "$WORK/out/$f")")"
		[ "$f" = "$BACKUP_FILE_TOMBSTONES" ] || entries="$entries,"
		entries="$entries"$'\n'
	done
	{
		printf '{\n'
		printf '  "schemaVersion": 1,\n'
		printf '  "stamp": "%s",\n' "$stamp"
		printf '  "startedAt": "%s",\n' "$started"
		printf '  "finishedAt": "%s",\n' "$finished"
		printf '  "sourceCommit": "%s",\n' "$source_commit"
		printf '  "postgresMajor": "%s",\n' "$pg_major"
		printf '  "tombstoneRows": %s,\n' "$rows"
		printf '  "buckets": [%s],\n' "$buckets_json"
		printf '  "files": {\n%s  }\n' "$entries"
		printf '}\n'
	} >"$WORK/out/$BACKUP_FILE_MANIFEST"

	# 5. Upload: the data, then verify it landed, then the manifest, then the pointer. Each later
	#    object vouches for the earlier ones, so a run killed half-way leaves no copy that looks whole.
	local dest
	dest="$(offbox_path "daily/$stamp")"
	log "uploading to the off-box store"
	upload_copy "$envf" "$dest"
	printf '{\n  "schemaVersion": 1,\n  "stamp": "%s",\n  "finishedAt": "%s"\n}\n' "$stamp" "$finished" >"$WORK/latest.json"
	rclone_run - "$envf" "$WORK" copyto /work/latest.json "$(offbox_path latest.json)"
	# The hourly pointer too, so a restore right after this run reads tombstones at least this new.
	cp "$WORK/out/$BACKUP_FILE_TOMBSTONES" "$WORK/latest.csv.age"
	printf '{\n  "schemaVersion": 1,\n  "exportedAt": "%s",\n  "rows": %s,\n  "sha256": "%s"\n}\n' \
		"$finished" "$rows" "$(sha256_of "$WORK/latest.csv.age")" >"$WORK/tomb-latest.json"
	rclone_run - "$envf" "$WORK" copyto /work/latest.csv.age "$(offbox_path tombstones/latest.csv.age)"
	rclone_run - "$envf" "$WORK" copyto /work/tomb-latest.json "$(offbox_path tombstones/latest.json)"
	log "daily copy $stamp complete"

	# 6. Weekly: the first complete daily of each ISO week, uploaded again from the same local files
	#    in the same order (data, check, manifest last), so a weekly is never half there and looking
	#    whole. Not a server-side copy: every object enters the store through the one upload path
	#    that an Object Lock bucket is known to accept.
	if [ -z "$(rclone_run - "$envf" "$WORK" lsf "$(offbox_path "weekly/$week/")" 2>/dev/null | grep -Fx "$BACKUP_FILE_MANIFEST" || true)" ]; then
		upload_copy "$envf" "$(offbox_path "weekly/$week")"
		log "weekly copy $week made from $stamp"
	fi

	# 7. Retention. Only after this run's copy is complete, so a failing night never deletes.
	apply_retention "$envf"
}

#######################################
# Uploads $WORK/out to DEST: the data files, `rclone check` that they landed, then the manifest.
#######################################
upload_copy() {
	local envf="$1" dest="$2"
	rclone_run - "$envf" "$WORK" copy /work/out "$dest" --exclude "$BACKUP_FILE_MANIFEST"
	rclone_run - "$envf" "$WORK" check /work/out "$dest" --one-way --exclude "$BACKUP_FILE_MANIFEST"
	rclone_run - "$envf" "$WORK" copyto "/work/out/$BACKUP_FILE_MANIFEST" "$dest/$BACKUP_FILE_MANIFEST"
}

#######################################
# Script mode: prunes dailies and weeklies beyond the keep counts. Bucket mode: deletes nothing and
# makes no store call at all; the bucket's lifecycle rules expire old copies.
#######################################
apply_retention() {
	local envf="$1" mode
	mode="$(retention_mode)" || exit 1
	if [ "$mode" = bucket ]; then
		log "retention: BACKUP_RETENTION=bucket, so the bucket's lifecycle rules expire old copies; nothing deleted here"
		return 0
	fi
	prune daily "$BACKUP_KEEP_DAILY" "$envf"
	prune weekly "$BACKUP_KEEP_WEEKLY" "$envf"
}

#######################################
# Deletes the copies under KIND (daily|weekly) that retention_select names.
#######################################
prune() {
	local kind="$1" keep="$2" envf="$3" name state listing doomed
	listing="$WORK/$kind.listing"
	: >"$listing"
	while IFS= read -r name; do
		name="${name%/}"
		if [ "$kind" = daily ]; then
			[[ "$name" =~ $BACKUP_STAMP_RE ]] || continue
		else
			[[ "$name" =~ ^[0-9]{4}-W[0-9]{2}$ ]] || continue
		fi
		if rclone_run - "$envf" "$WORK" lsf "$(offbox_path "$kind/$name/")" | grep -Fxq "$BACKUP_FILE_MANIFEST"; then
			state=complete
		else
			state=incomplete
		fi
		# retention_select sorts on the first field; a week name is mapped to a sortable stamp shape.
		if [ "$kind" = weekly ]; then
			printf '%s %s %s\n' "$(printf '%s' "$name" | tr -d 'W-')00T000000Z" "$state" "$name"
		else
			printf '%s %s %s\n' "$name" "$state" "$name"
		fi >>"$listing"
	done < <(rclone_run - "$envf" "$WORK" lsf --dirs-only "$(offbox_path "$kind/")" 2>/dev/null || true)
	doomed="$(cut -d' ' -f1,2 "$listing" | retention_select "$keep")"
	[ -n "$doomed" ] || return 0
	local key
	while IFS= read -r key; do
		name="$(awk -v k="$key" '$1 == k { print $3; exit }' "$listing")"
		[ -n "$name" ] || continue
		log "retention: removing $kind/$name"
		rclone_run - "$envf" "$WORK" purge "$(offbox_path "$kind/$name")"
	done <<<"$doomed"
}

#######################################
# B7's listing. Prints one JSON line and exits 0 (fresh), 1 (stale) or 2 (could not read).
# An unreadable store is NOT reported as "no backup": that would be an error read as an absence.
#######################################
cmd_status() {
	require_cmd docker
	WORK="$(secret_dir "${BACKUP_WORKDIR:-}")"
	local envf stamp finished finished_epoch now age_s tomb_at
	envf="$(offbox_env_file "$WORK")"
	if ! rclone_run - "$envf" "$WORK" cat "$(offbox_path latest.json)" >"$WORK/latest.json" 2>"$WORK/err"; then
		printf '{"check":"off-box-backup","verdict":"not-measured","reason":"latest.json could not be read"}\n'
		return 2
	fi
	stamp="$(manifest_field "$WORK/latest.json" stamp)"
	[[ "$stamp" =~ $BACKUP_STAMP_RE ]] || {
		printf '{"check":"off-box-backup","verdict":"not-measured","reason":"latest.json names no valid stamp"}\n'
		return 2
	}
	if ! rclone_run - "$envf" "$WORK" cat "$(offbox_path "daily/$stamp/$BACKUP_FILE_MANIFEST")" >"$WORK/manifest.json" 2>"$WORK/err"; then
		printf '{"check":"off-box-backup","verdict":"not-measured","reason":"the manifest latest.json names could not be read","newest":"%s"}\n' "$stamp"
		return 2
	fi
	finished="$(manifest_field "$WORK/manifest.json" finishedAt)"
	finished_epoch="$(epoch_of "$finished")" || {
		printf '{"check":"off-box-backup","verdict":"not-measured","reason":"manifest finishedAt is unreadable","newest":"%s"}\n' "$stamp"
		return 2
	}
	now="$(date -u +%s)"
	age_s=$((now - finished_epoch))
	tomb_at=""
	if rclone_run - "$envf" "$WORK" cat "$(offbox_path tombstones/latest.json)" >"$WORK/tomb.json" 2>/dev/null; then
		tomb_at="$(manifest_field "$WORK/tomb.json" exportedAt)"
	fi
	local verdict=pass rc=0
	if [ "$age_s" -ge $((BACKUP_MAX_AGE_HOURS * 3600)) ]; then
		verdict=fail
		rc=1
	fi
	printf '{"check":"off-box-backup","verdict":"%s","newest":"%s","finishedAt":"%s","ageSeconds":%s,"maxAgeHours":%s,"tombstonesExportedAt":"%s"}\n' \
		"$verdict" "$stamp" "$finished" "$age_s" "$BACKUP_MAX_AGE_HOURS" "$tomb_at"
	return "$rc"
}

#######################################
# Hermetic checks of the parts that decide something: retention, the manifest readers, the dotenv
# reader, the date parser and the recipient check. Every assertion counts toward the exit code;
# nothing runs in a subshell whose failure could be lost.
#######################################
cmd_self_test() {
	local fails=0 got want tmp
	tmp="$(secret_dir)"
	WORK="$tmp" # removed by the EXIT trap

	check() { # check <name> <got> <want>
		if [ "$2" = "$3" ]; then
			printf 'ok    %s\n' "$1"
		else
			printf 'FAIL  %s\n      got:  %q\n      want: %q\n' "$1" "$2" "$3"
			fails=$((fails + 1))
		fi
	}

	# Retention: keep the newest 2 complete; drop everything older than the oldest kept.
	got="$(printf '%s\n' \
		'20261201T020000Z complete' '20261202T020000Z complete' '20261203T020000Z incomplete' \
		'20261204T020000Z complete' '20261130T020000Z incomplete' | retention_select 2 | tr '\n' ' ')"
	check "retention keeps the newest N complete" "$got" "20261201T020000Z 20261130T020000Z "
	got="$(printf '%s\n' '20261205T020000Z incomplete' '20261204T020000Z complete' | retention_select 1 | tr '\n' ' ')"
	check "retention spares an incomplete copy newer than the kept one" "$got" ""
	got="$(printf '%s\n' 'garbage complete' '../etc complete' '20261204T020000Z complete' | retention_select 1 | tr '\n' ' ')"
	check "retention never names a malformed stamp" "$got" ""
	got="$(printf '%s\n' '20261201T020000Z complete' '20261202T020000Z complete' | retention_select 14 | tr '\n' ' ')"
	check "retention deletes nothing under the window" "$got" ""
	got="$(retention_select 1 </dev/null | tr '\n' ' ')"
	check "retention on an empty listing deletes nothing and does not fail" "$got" ""
	if (retention_select 0 </dev/null >/dev/null 2>&1); then got=accepted; else got=refused; fi
	check "retention refuses keep=0 (it would delete everything)" "$got" refused

	# Manifest readers, on the exact shape cmd_run writes.
	cat >"$tmp/m.json" <<-'JSON'
		{
		  "schemaVersion": 1,
		  "stamp": "20261201T023000Z",
		  "startedAt": "2026-12-01T02:30:00Z",
		  "finishedAt": "2026-12-01T02:41:07Z",
		  "sourceCommit": "703d40d946914ab0dafdb4ed643a2c2437fa7def",
		  "postgresMajor": "17",
		  "tombstoneRows": 3,
		  "buckets": ["a", "b"],
		  "files": {
		    "postgres.dump.age": {"bytes": 10, "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
		    "storage.tar.gz.age": {"bytes": 20, "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
		    "tombstones.csv.age": {"bytes": 30, "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
		  }
		}
	JSON
	check "manifest stamp" "$(manifest_field "$tmp/m.json" stamp)" "20261201T023000Z"
	check "manifest finishedAt" "$(manifest_field "$tmp/m.json" finishedAt)" "2026-12-01T02:41:07Z"
	check "manifest sourceCommit" "$(manifest_field "$tmp/m.json" sourceCommit)" "703d40d946914ab0dafdb4ed643a2c2437fa7def"
	check "manifest sha of the storage file" "$(manifest_sha256 "$tmp/m.json" storage.tar.gz.age)" \
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	check "manifest sha of an absent file is empty" "$(manifest_sha256 "$tmp/m.json" nope.age)" ""

	# The dotenv reader: last assignment wins, quotes come off, nothing is executed.
	cat >"$tmp/e.env" <<-'ENV'
		ALETHIA_STORAGE_ACCESS_KEY_ID=first
		# ALETHIA_STORAGE_ACCESS_KEY_ID=commented
		ALETHIA_STORAGE_ACCESS_KEY_ID="second"
		export QUOTED='x y'
		EVIL=$(touch SELFTEST_PWNED)
	ENV
	check "dotenv: last assignment wins, quotes removed" "$(env_file_value "$tmp/e.env" ALETHIA_STORAGE_ACCESS_KEY_ID)" second
	check "dotenv: export prefix and single quotes" "$(env_file_value "$tmp/e.env" QUOTED)" "x y"
	check "dotenv: absent key is empty" "$(env_file_value "$tmp/e.env" MISSING)" ""
	(cd "$tmp" && env_file_value "$tmp/e.env" EVIL >/dev/null)
	if [ -e "$tmp/SELFTEST_PWNED" ]; then got=executed; else got=inert; fi
	check "dotenv: a command substitution is never run" "$got" inert
	env_file_set "$tmp/e.env" QUOTED replaced
	check "dotenv: set replaces in place" "$(env_file_value "$tmp/e.env" QUOTED)" replaced
	env_file_set "$tmp/e.env" NEWKEY added
	check "dotenv: set appends a missing key" "$(env_file_value "$tmp/e.env" NEWKEY)" added

	# The date parser, on the platform it runs on, and its refusals.
	check "epoch of a known instant" "$(epoch_of 2026-12-01T00:00:00Z)" 1796083200
	if epoch_of "2026-12-01 00:00:00" >/dev/null 2>&1; then got=accepted; else got=refused; fi
	check "epoch refuses a non-RFC-3339 string" "$got" refused
	if epoch_of "" >/dev/null 2>&1; then got=accepted; else got=refused; fi
	check "epoch refuses empty" "$got" refused

	# Recipients: a valid key passes, anything else stops the run before a byte is written.
	want="age1mnuyv5hkq0j5med229xhdcnsc20k3fpuq9t203va0tdz8tg8dqpvj49uhn"
	got="$(BACKUP_AGE_RECIPIENTS="$want" age_recipient_args | tr '\n' ' ')"
	check "a valid age recipient becomes -r arguments" "$got" "-r $want "
	if (BACKUP_AGE_RECIPIENTS="ssh-ed25519 AAAA" age_recipient_args >/dev/null 2>&1); then got=accepted; else got=refused; fi
	check "an ssh key is refused as a recipient" "$got" refused
	if (BACKUP_AGE_RECIPIENTS="" age_recipient_args >/dev/null 2>&1); then got=accepted; else got=refused; fi
	check "no recipient is refused" "$got" refused
	# Production encrypts to three: the maintainer's offline key, the recovery key, and the drill key.
	local r2 r3
	r2="age1$(printf 'q%.0s' {1..58})" # the shape the check reads; not a real key
	r3="age1$(printf 'z%.0s' {1..58})"
	got="$(BACKUP_AGE_RECIPIENTS="$want $r2  $r3" age_recipient_args | tr '\n' ' ')"
	check "three recipients become three -r pairs, in order" "$got" "-r $want -r $r2 -r $r3 "
	if (BACKUP_AGE_RECIPIENTS="$want ${r2}x $r3" age_recipient_args >/dev/null 2>&1); then got=accepted; else got=refused; fi
	check "one malformed key among three refuses the whole list" "$got" refused

	# The offbox env file is private.
	got="$(BACKUP_S3_ENDPOINT=https://s3.example.invalid BACKUP_S3_BUCKET=b BACKUP_S3_ACCESS_KEY_ID=k \
		BACKUP_S3_SECRET_ACCESS_KEY=s offbox_env_file "$tmp")"
	check "offbox env file path" "$got" "$tmp/offbox.env"
	check "offbox env file is 0600" "$(stat -c %a "$got" 2>/dev/null || stat -f %Lp "$got")" 600
	if (unset BACKUP_S3_SECRET_ACCESS_KEY; BACKUP_S3_ENDPOINT=x BACKUP_S3_BUCKET=b BACKUP_S3_ACCESS_KEY_ID=k \
		offbox_env_file "$tmp" >/dev/null 2>&1); then got=accepted; else got=refused; fi
	check "a missing off-box secret is refused" "$got" refused

	# Retention mode: script by default, bucket on request, and nothing else.
	check "retention mode defaults to script" "$(unset BACKUP_RETENTION; retention_mode)" script
	check "retention mode bucket" "$(BACKUP_RETENTION=bucket retention_mode)" bucket
	if (BACKUP_RETENTION=Bucket retention_mode >/dev/null 2>&1); then got=accepted; else got=refused; fi
	check "a mistyped retention mode is refused, never read as script" "$got" refused

	# What the off-box remote is told, per mode. The values are fakes; only the shape is read.
	local s3env=(BACKUP_S3_ENDPOINT=https://s3.example.invalid BACKUP_S3_BUCKET=b BACKUP_S3_ACCESS_KEY_ID=k
		BACKUP_S3_SECRET_ACCESS_KEY=s)
	envhas() { # envhas <file> <exact line> -> yes|no
		if grep -Fxq "$2" "$1"; then printf yes; else printf no; fi
	}
	offbox_env_child() { # offbox_env_child <VAR=value…>: offbox_env_file in a fresh bash, no set -e
		# shellcheck disable=SC2016 # $1 and $2 are the child's positional arguments
		env "$@" bash -c '. "$1"; offbox_env_file "$2"' _ "$HERE/lib.sh" "$tmp"
	}
	got="$(offbox_env_child -u BACKUP_RETENTION -u BACKUP_S3_SSE_KMS_KEY_ID -u BACKUP_S3_SESSION_TOKEN "${s3env[@]}")"
	check "script mode keeps rclone's default upload cutoff" "$(grep -c '^RCLONE_CONFIG_OFFBOX_UPLOAD_CUTOFF=' "$got")" 0
	check "no KMS key named, no SSE header" "$(grep -c '^RCLONE_CONFIG_OFFBOX_SERVER_SIDE_ENCRYPTION=' "$got")" 0
	check "no session token, no token line" "$(grep -c '^RCLONE_CONFIG_OFFBOX_SESSION_TOKEN=' "$got")" 0
	got="$(offbox_env_child "${s3env[@]}" BACKUP_RETENTION=bucket \
		BACKUP_S3_SSE_KMS_KEY_ID=arn:aws:kms:eu-central-1:111111111111:key/example BACKUP_S3_SESSION_TOKEN=t)"
	check "bucket mode makes every upload multipart (Content-MD5 on each part)" \
		"$(envhas "$got" RCLONE_CONFIG_OFFBOX_UPLOAD_CUTOFF=0)" yes
	check "a named KMS key sets aws:kms" "$(envhas "$got" RCLONE_CONFIG_OFFBOX_SERVER_SIDE_ENCRYPTION=aws:kms)" yes
	check "a named KMS key is passed as that key" \
		"$(envhas "$got" RCLONE_CONFIG_OFFBOX_SSE_KMS_KEY_ID=arn:aws:kms:eu-central-1:111111111111:key/example)" yes
	check "a session token is passed" "$(envhas "$got" RCLONE_CONFIG_OFFBOX_SESSION_TOKEN=t)" yes
	if (offbox_env_child "${s3env[@]}" BACKUP_RETENTION=nope >/dev/null 2>&1); then got=accepted; else got=refused; fi
	check "a mistyped retention mode stops the off-box config too" "$got" refused

	# Retention dispatch, against a recording stand-in for rclone: script mode purges the copies past
	# the keep count; bucket mode makes no store call at all, so it cannot delete.
	rclone_run() { # the stand-in: record the call, answer listings
		printf '%s\n' "$*" >>"$tmp/rclone.calls"
		case "$*" in
			*"lsf --dirs-only OFFBOX:b/p/daily/") printf '20261201T023000Z/\n20261202T023000Z/\n20261203T023000Z/\n' ;;
			*"lsf OFFBOX:b/p/daily/"*) printf '%s\n' "$BACKUP_FILE_MANIFEST" ;;
		esac
	}
	: >"$tmp/rclone.calls"
	BACKUP_RETENTION=script BACKUP_KEEP_DAILY=1 BACKUP_S3_BUCKET=b BACKUP_PREFIX=p apply_retention "$tmp/x.env" 2>/dev/null
	check "script mode purges the dailies past the keep count" \
		"$(grep '^- .* purge ' "$tmp/rclone.calls" | sed 's/.* purge //' | sort | tr '\n' ' ')" \
		"OFFBOX:b/p/daily/20261201T023000Z OFFBOX:b/p/daily/20261202T023000Z "
	: >"$tmp/rclone.calls"
	BACKUP_RETENTION=bucket BACKUP_KEEP_DAILY=1 BACKUP_S3_BUCKET=b BACKUP_PREFIX=p apply_retention "$tmp/x.env" 2>/dev/null
	check "bucket mode makes no store call during retention" "$(wc -l <"$tmp/rclone.calls" | tr -d ' ')" 0

	if [ "$fails" -ne 0 ]; then
		printf '\n%s self-test assertion(s) failed\n' "$fails"
		return 1
	fi
	printf '\nall self-test assertions passed\n'
}

case "${1:-}" in
	run) cmd_run ;;
	tombstones) cmd_tombstones ;;
	status) cmd_status ;;
	--self-test) cmd_self_test ;;
	-h | --help | help) usage ;;
	*) usage >&2; exit 64 ;;
esac
