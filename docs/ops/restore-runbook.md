<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Off-box backup and restore runbook

This runbook covers the production box's off-box backup to AWS, its credentials, the restore drill,
and what a real recovery adds to the drill. It is the operator half of board units REL-L7 (#6908) and
BKP-L1 (#7243), and the instrument behind two of the three parts of beta predicate **B7**
([`docs/beta/README.md`](../beta/README.md)).

| B7 part | Instrument | Passes when |
|---|---|---|
| Off-box backup | `deploy/prod/backup/backup.sh status` | the newest complete daily copy is less than 26 hours old (exit 0) |
| Restore drill | `scripts/ops/restore-drill.sh` and the record it writes | the newest record in `docs/beta/evidence/b7/` has `verdict: pass`, `tombstonesReplayed: true`, a `durationSeconds`, and a `date` within 45 days |

Nothing here runs by itself until [the one-time setup](#one-time-setup-operator) is done.
Everything that creates a resource, holds a credential or touches the production box is done by the
maintainer, or by an operator session the maintainer has given those permissions.

## What is backed up, and where it goes

Production is one box (`deploy/prod/README.md`). Postgres and SeaweedFS live on an attached Hetzner
volume, and Hetzner's server backups do not include attached volumes. The off-box backup is therefore
the only second copy of the database and of every customer's tofu state. It goes to a **second
provider**: an S3 bucket in the AWS member account `alethia-backup`, region `eu-central-1`.

| What | How | Why |
|---|---|---|
| Postgres | `pg_dump -Fc` inside the running postgres container, streamed into `age` | a logical dump restores onto any Postgres 17, not only onto the same disk |
| SeaweedFS | every bucket (customer tofu state and plan artefacts), copied by an rclone container on the compose network, then `tar`, `gzip` and `age` | losing a customer's tofu state loses their infrastructure's record |
| Erasure tombstones | `privacy_erasure_tombstone` as CSV, in every daily copy **and** hourly on its own | see [Tombstones](#tombstones-why-there-is-an-hourly-export) |

Every file is encrypted to the age **public** keys in `BACKUP_AGE_RECIPIENTS` before it leaves the box.
No private key is ever on the box, so the box can write a backup but cannot read one. The bucket adds a
second layer, SSE-KMS with the account's own key, which controls who at AWS can read the ciphertext.

The store's layout, under `<bucket>/<BACKUP_PREFIX>/`:

```text
daily/<YYYYMMDDTHHMMSSZ>/postgres.dump.age
                         storage.tar.gz.age
                         tombstones.csv.age
                         manifest.json          written last: no manifest means not a backup
weekly/<YYYY-Www>/…                             first complete daily of each ISO week, uploaded again
latest.json                                     names the newest complete daily
tombstones/latest.csv.age, tombstones/latest.json   rewritten every hour
```

The nightly runs at 02:30 UTC (`alethia-backup.timer`); the tombstone export runs hourly
(`alethia-backup-tombstones.timer`). A missed slot runs at the next boot (`Persistent=true`). One
missed night is already a failing B7, because the window is 26 hours.

## Retention: the bucket deletes, the box never does

`BACKUP_RETENTION` picks who deletes old copies.

| Mode | Who deletes | The box key needs | For |
|---|---|---|---|
| `bucket` | the bucket's lifecycle rules | put, get, list. **No delete.** | production, on AWS |
| `script` (default when unset) | `backup.sh`, with `rclone purge`, after a complete night | put, get, list **and delete** | a self-hosted or other S3-compatible store with no lifecycle rules |

In `bucket` mode `backup.sh` makes no delete call at all, and the box key could not make one anyway.
Whoever controls the box can add copies but cannot remove or shorten the ones already there. The
bucket (stack `infra/backup-account`, board unit BKP-S1) holds:

- **Object Lock in COMPLIANCE mode, with a 15-day default retention.** Each object version cannot be
  overwritten or deleted by anyone, including the account root, for 15 days after it is written.
- **Lifecycle rules**: current versions under `daily/` expire after 15 days and under `weekly/` after
  60 days; a noncurrent version is removed 16 days after it stopped being current. That is 14 dailies
  and 8 weeklies, the same counts as `script` mode's defaults.
- **Versioning**, which Object Lock requires. Rewriting `latest.json` or the hourly tombstone export
  leaves the old version behind as noncurrent, and the noncurrent rule removes it.

On a versioned bucket, expiry is two steps: the expiry adds a delete marker, and the noncurrent rule
removes the data 16 days later. So a daily copy's bytes are physically gone about 31 days after it was
written, and a weekly's about 76 days after. That is the figure to use when a privacy text says when
deleted data leaves the backups.

What changes from `script` mode: `script` never deletes after a failing night. In `bucket` mode a daily
expires on age whatever happened since. That is acceptable only because the daily freshness check
(BKP-L2) alarms within 26 hours, long before a copy is 15 days old, and the weeklies hold eight weeks.

### Object Lock and the pinned rclone

S3 refuses an upload into a bucket with Object Lock retention unless the request carries `Content-MD5`
or an SDK checksum header. Every transfer goes through `rclone/rclone:1.68.2` (`BACKUP_RCLONE_IMAGE` in
`deploy/prod/backup/lib.sh`). This is what that version's source establishes. Nothing has been tested
against a real bucket yet: the first nightly is that test.

- **Multipart uploads always carry `Content-MD5`.** rclone's chunk writer hashes each part's own bytes
  and sets `ContentMD5` on every `UploadPart` (`backend/s3/s3.go` at tag `v1.68.2`, the `WriteChunk`
  method of the multipart writer). The value comes from the bytes being sent, not from the source.
- **Single-part uploads carry `Content-MD5` only when the source can report an MD5.**
  `prepareUpload` sets `ContentMD5` from `src.Hash(MD5)`. A local file can report one, but rclone's
  own documentation for this version ("Object-lock enabled S3 bucket" in `docs/content/s3.md`) says
  single-part uploads into a lock-enabled bucket fail, and gives `--s3-upload-cutoff 0` as the fix.
- The vendored AWS SDK (`aws-sdk-go-v2/service/s3` v1.58.3) predates the SDK's default request
  checksums, so nothing else adds a checksum header.

So in `bucket` mode `lib.sh` sets the remote's `upload_cutoff` to 0, and **every upload is multipart**.
This needs no change to the pinned image, so the pin stays at 1.68.2. Multipart also makes rclone record
each file's MD5 as object metadata, which `rclone check` and a download use to verify the file.

Two more settings follow from the same source:

- **`BACKUP_S3_SSE_KMS_KEY_ID` must name the bucket's KMS key.** rclone reads an ETag as an MD5 unless it
  is told the bucket uses SSE-KMS, and under SSE-KMS the ETag is not an MD5. Without the setting, the
  upload fails rclone's ETag check. Setting it also makes S3 encrypt with that key rather than the
  AWS-managed one.
- **The weekly copy is uploaded again from the box**, not copied server-side, so every object reaches
  the store through the same upload path.

A failure here is not silent. S3 refuses the request, rclone exits non-zero, the unit fails and is
listed in `systemctl --failed`, and the next `backup.sh status` reports the copy stale.

Later rclone versions change this code. v1.74.0 adds explicit Object Lock flags and its own MD5
buffering for them, and those flags are not used here. Before bumping the pin, read the new version's
source again.

## Tombstones: why there is an hourly export

A backup taken before an erasure brings the erased rows back when it is restored, and they look
exactly like rows that were never erased. `privacy_erasure_tombstone` is what outlives an erasure
(`apps/console/lib/db/schema/privacy.ts`). A restore is not complete until every tombstone has been
re-applied.

A dump cannot carry the tombstones of erasures made **after** it was taken. So:

1. The restore merges the newest hourly export into the restored database, on top of the tombstones in
   the dump itself.
2. It sets `replayed_at` to null on every tombstone. A value carried in from production or from an
   earlier restore says nothing about this one.
3. It runs `apps/console/scripts/ops/replay-tombstones.ts --apply` in the console-migrate image. That
   re-runs the same executor the erasure ran (`applyErasurePlan`) with the same register
   (`ERASURE_RULES`), restricted to the tables each tombstone's scope names. A table in a scope that the
   register no longer has a rule for stops the replay; it is not skipped.
4. It runs `--check`, and does not start the console unless no tombstone is left unreplayed.

The remaining gap is an erasure made after the last hourly export, so at most about an hour. If the
failed box is still reachable, run `backup.sh tombstones` on it before restoring, and the gap closes.

## The keys

| Key | Kind | Where it lives | Used for |
|---|---|---|---|
| primary | age identity | offline, in the maintainer's password manager | decrypting a copy in a real recovery |
| breakglass | age identity | offline, in the password manager and in a second, separate place | the same, if the first is lost |
| drill | age identity | the backup account's Secrets Manager, readable only by the drill instance role | the weekly automated drill (BKP-L3) |
| `backup-writer` | IAM user access key | `/etc/alethia/backup.env` on the box, and the vault | the box's uploads: put, get, list, from the box's addresses only |
| recovery credential | Identity Center session | nowhere: an admin opens it when needed | reading the bucket when the box is lost |

All three age public keys go into `BACKUP_AGE_RECIPIENTS`, so any one identity decrypts any copy. The
two offline identities are what keep recovery possible if the backup account itself is lost. The drill
identity is online by design, so an admin of the backup account holds both the ciphertext and a key to
it. The account's admin access is Identity Center only.

## Prerequisites

- On the production box: Docker (already there) and `age` (`apt-get install -y age`).
- On the operator's machine: `age`, and AWS CLI v2 with an Identity Center profile for the
  `alethia-backup` account's admin permission set. This runbook calls it `alethia-backup-admin`.

## One-time setup (operator)

This needs the backup scripts on `main` and deployed (BKP-0), so that `/opt/alethia/deploy/prod/backup/`
exists on the box.

1. **Create the member account `alethia-backup`** from the management account, and assign the Identity
   Center admin permission set to it.
2. **Apply the `infra/backup-account` stack** (BKP-S1) from its reviewed plan. Note its outputs: the
   bucket name and the KMS key ARN.
3. **Create the three age identities**, offline, on your own machine, outside any repository:

   ```sh
   deploy/prod/backup/ops/generate-age-identities.sh --out ~/alethia-backup-keys
   ```

   It prints only the three public keys and the `BACKUP_AGE_RECIPIENTS` line. Keep the primary file in
   the password manager, and the breakglass file there and in a second place too. Put the drill file's
   contents into the Secrets Manager secret the stack created, then delete the local drill file.
   Losing every identity makes every backup unreadable; there is no recovery from that.
4. **Mint the writer key** with the CLI, never with tofu, so it is not in any state file:

   ```sh
   aws sso login --profile alethia-backup-admin
   (umask 077 && aws iam create-access-key --user-name backup-writer \
     --profile alethia-backup-admin --output json > ./backup-writer-key.json)
   ```

5. **Put the key in the vault** (`alethia/prod/env`): `BACKUP_S3_ACCESS_KEY_ID` and
   `BACKUP_S3_SECRET_ACCESS_KEY`, so they outlive the box. The deploy does not read them; the box gets
   its own copy in step 7.
6. **Prepare the values file** on your own machine, 0600, outside any repository: the keys of
   `deploy/prod/backup/backup.env.example` with the bucket and KMS key ARN from step 2, the writer key
   from step 4, and the `BACKUP_AGE_RECIPIENTS` line from step 3.
7. **Run the box setup over SSH.** `deploy/prod/backup/ops/setup-box.sh` installs age if missing,
   writes `/etc/alethia/backup.env` (root:root 0600), installs and enables the two timers, takes the
   first copy and runs `backup.sh status`. It ends with `RESULT: PASS` or `RESULT: FAIL (<step>)`, and
   is safe to run again. The values travel over the SSH connection on stdin:

   ```sh
   ssh root@<box> /opt/alethia/deploy/prod/backup/ops/setup-box.sh --values - --dry-run < values.env
   ssh root@<box> /opt/alethia/deploy/prod/backup/ops/setup-box.sh --values - < values.env
   ```

   The first copy is also the first real test of the Object Lock uploads. The temporary bucket copy is
   written to `$BACKUP_WORKDIR` (default: the system temp directory), so that directory needs room for
   one copy of the SeaweedFS buckets. Step by step: `deploy/prod/backup/ops/README.md`.
8. **Delete** `backup-writer-key.json` and the values file. The secret is now only in the vault and on
   the box. Move the drill identity into Secrets Manager (step 3) if you have not.
9. If it printed `FAIL`, read the step it names and `journalctl -u alethia-backup.service -n 50` on
   the box, fix the cause, and run step 7 again.
10. **Run the first drill**, below, and commit its record.

## Rotating the writer key (yearly, or at once if the box is suspect)

An IAM user can hold two access keys, so rotation never leaves the box without one.

1. Mint a second key exactly as in setup step 4.
2. Replace both values in the vault, and on the box by running the box setup again with the new
   values (setup step 7; add `--no-first-run` to skip the extra copy).
3. Prove the new key writes: `systemctl start alethia-backup-tombstones.service`, then
   `journalctl -u alethia-backup-tombstones.service -n 5` shows `tombstones exported off-box`.
4. Deactivate the old key: `aws iam list-access-keys --user-name backup-writer --profile
   alethia-backup-admin` shows both keys, then
   `aws iam update-access-key --user-name backup-writer --access-key-id <old id> --status Inactive
   --profile alethia-backup-admin`.
5. After the next nightly, check `backup.sh status` passes. Then delete the old key with
   `aws iam delete-access-key` and the same two arguments.

If the box may be compromised, skip the wait: deactivate the old key at step 4 right away. The copies
already in the bucket are safe whatever that key did. It could not delete them or shorten their
retention, and it cannot decrypt them.

## The recovery credential

The writer key is not used to read the bucket in a recovery: it lives on the box, which may be the
thing that was lost. An Identity Center admin opens a session for the `alethia-backup` account when it
is needed, and it expires by itself. To use it with the scripts:

```sh
aws sso login --profile alethia-backup-admin
eval "$(aws configure export-credentials --profile alethia-backup-admin --format env)"
export BACKUP_S3_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  BACKUP_S3_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  BACKUP_S3_SESSION_TOKEN="$AWS_SESSION_TOKEN"
```

Both `backup.sh status` and `scripts/ops/restore-drill.sh` take these from the environment. The
environment wins over the drill's `--env-file`, and `lib.sh` passes the session token to rclone. The
session lasts as long as the permission set's session duration. Set that to cover a restore, a few
hours, before you need it.

## The restore drill

The drill restores the newest copy onto a throwaway machine. It times the run from an empty machine to a
console whose readiness body says `healthy`, and writes the B7 record. Run it once at setup and again at
the release candidate. The record must be newer than 45 days for B7 to pass. It runs on EC2 in the
backup account, not on Hetzner. Normally `.github/workflows/restore-drill.yml` runs it every week
(below). The manual steps further down are for a drill with a specific copy or commit, or for when the
workflow cannot run.

### The weekly automated drill

`.github/workflows/restore-drill.yml` runs on Mondays at 06:41 UTC, and on a manual dispatch from
`main`. It needs three repository **variables** (not secrets), all taken from
`tofu output` in `infra/backup-account`:

| Variable | Output |
|---|---|
| `BACKUP_DRILL_LAUNCHER_ROLE_ARN` | `drill_launcher_role_arn` |
| `BACKUP_DRILL_LAUNCH_TEMPLATE_ID` | `drill_launch_template_id` |
| `BACKUP_BUCKET` | `bucket_name` |

`BACKUP_AWS_REGION` (default `eu-central-1`) and `BACKUP_DRILL_MAX_WAIT_MINUTES` (default 240, from 30
to 270; keep it at or above `drill_max_lifetime_minutes`) are optional. While any of the three is unset, the run
is green and its summary says "not configured". The drill identity must also be in its Secrets
Manager secret (setup step 3).

What one run does:

1. Assumes `drill-launcher` over OIDC and starts **one** spot instance from the launch template,
   overriding nothing. The instance schedules its own power-off at the template's maximum lifetime
   before it does anything else. Powering off terminates it.
2. On the instance, `scripts/ops/restore-drill-ec2.sh` takes the instance role's credentials from
   the metadata service and fetches the drill identity from Secrets Manager itself. The identity
   never passes through the workflow. It runs `scripts/ops/restore-drill.sh --target drill
   --execute` with the clock started at boot, then uploads the record, its log and a `result.json`
   to `evidence/<instance id>/` in the bucket, and powers off.
3. The workflow waits for the power-off, then **always** terminates the instance, even after a
   failure or a cancelled run. It downloads the evidence.
4. On a pass, it opens a PR into `dev` (branch `chore/restore-drill-evidence`) that adds the record and
   log under `docs/beta/evidence/b7/`. Merge it like any other PR.
5. Any other outcome turns the run red and opens or updates one issue, **Restore drill failing**. The
   next pass closes it. The possible outcomes are `fail` (the record says which step), `missing` (no
   result; read the instance's system log in the EC2 console), `timeout` or `launch-failed` (spot
   capacity, quota or the role).

`scripts/ops/restore-drill-launch.sh` holds every step of the workflow. On a pull request the workflow
runs only the three scripts' self-tests and launches nothing.

### What the drill script refuses and protects

What the script refuses, with no flag to override any of it:

- a `--target` other than `drill`. There is no production target.
- a host named `alethia-cp`, the production server's name.
- a Docker with any container or volume of the production compose project (`alethia`).
- a `/opt/alethia/.env` that sets `TUNNEL_TOKEN`.
- a box that already has volumes of the drill project. A drill measures an empty box.

What it does to protect the restored data:

- The drill stack runs as compose project `alethia-drill`, on a network with **no egress**. A restored
  console cannot send an email, call a webhook or reach a customer's cloud. Only Postgres, SeaweedFS,
  the migrate one-shot and the console start. The runner, Caddy and the tunnel never start.
- The drill gets fresh random database passwords and none of production's secrets. Credentials stored
  encrypted in the database stay ciphertext, because the drill does not get the key.
- Decrypted files live in a 0700 directory that the script removes on exit. Unless you pass `--keep`,
  the drill stack and its volumes are removed after the record is written.
- The record and its log carry counts, timings, the backup stamp and the readiness body. They carry no
  personal data.

### By hand

Steps:

1. Note the time, so the record can include the machine's creation: `T0=$(date -u +%s)`.
2. Launch one instance in the backup account, `eu-central-1`: x86 (the production images are
   `linux/amd64`), Ubuntu 24.04, 4 vCPU and 8 GB or more, a security group with **no inbound rules**,
   IMDSv2 required, shutdown behaviour **terminate**. Connect with Session Manager.
3. On it, install Docker and age, and check out the repository at the commit you want to drill with:

   ```sh
   curl -fsSL https://get.docker.com | sh
   apt-get install -y age
   git clone https://github.com/alethialabs-io/alethialabs /root/alethia && cd /root/alethia
   ```

4. Give it two things, each kept 0600: a `backup.env` holding the store settings (endpoint, region,
   provider, bucket, prefix), and one age identity file. Export the
   [recovery credential](#the-recovery-credential) in the shell; the drill only reads.
5. Dry run. It checks the box and the listing, prints the plan and changes nothing:

   ```sh
   scripts/ops/restore-drill.sh --target drill --env-file /root/backup.env
   ```

6. Run it:

   ```sh
   scripts/ops/restore-drill.sh --target drill --execute \
     --env-file /root/backup.env --age-identity /root/drill.agekey --started-at "$T0"
   ```

   With no `--image-tag`, it restores with the console image that was running when the backup was
   taken (the manifest's `sourceCommit`). If that image predates `replay-tombstones.ts`, the script
   mounts this checkout's copy and runs it against the image's own erasure register.
7. The script writes `docs/beta/evidence/b7/<date>-restore-drill.md` and a `.log` beside it, on pass
   or fail. Copy both off the instance and open a PR into `dev` with them.
8. Delete the identity file and the `backup.env`, then **terminate the instance**. It held restored
   production data.

A failed drill also writes a record, with `verdict: fail` and the step that failed. It does not count
for B7. Fix the cause and run the drill again on a new instance.

## A real recovery (box lost)

This part has not been drilled. The drill script refuses production-shaped targets on purpose, so a
real recovery runs the same steps by hand:

1. Provision the new box with `infra/cp-hetzner` (maintainer). Do **not** run the deploy yet: its
   first `compose up` would migrate an empty database and start serving it.
2. Open the [recovery credential](#the-recovery-credential), and read which copy is newest:
   `backup.sh status` prints its stamp. Download that copy, check it and decrypt it with the primary
   or breakglass identity:

   ```sh
   aws s3 cp --recursive --profile alethia-backup-admin \
     "s3://<bucket>/alethia-prod/daily/<stamp>/" ./in/
   aws s3 cp --recursive --profile alethia-backup-admin \
     "s3://<bucket>/alethia-prod/tombstones/" ./in/tombstones/
   # every sha256 must match manifest.json before anything is decrypted
   sha256sum ./in/*.age; cat ./in/manifest.json
   age -d -i alethia-backup-primary.agekey -o postgres.dump ./in/postgres.dump.age
   ```

3. On the new box, check out the commit named in the manifest's `sourceCommit`. Write `/opt/alethia/.env`
   with the values the deploy would write: the keys `scripts/ci/deploy-console-assemble-env.sh` emits,
   from the vault. The restored console needs production's real secrets, including the credential
   encryption key, or every stored credential stays unreadable.
4. Start only `postgres` and `seaweedfs` with the production compose files. Then do what the drill does
   against project `alethia`: `pg_restore`, load the buckets, run `migrate`, merge and replay the
   tombstones, and check that none is left. `scripts/ops/restore-drill.sh` is the reference for each
   command.
5. Run the deploy. Its `compose up` starts the console on the restored data.
6. Run the box setup on the new box (setup steps 6 and 7), and add
   the new box's addresses to the writer's allowed source addresses in `infra/backup-account`. Run
   `backup.sh status` after the next nightly.

## Checking B7

- **Backup:** `backup.sh status` prints one JSON line. Exit 0 is fresh, 1 is older than 26 hours, and
  2 means the store could not be read. Exit 2 is not "no backup": it means nothing was measured.
- **Drill:** the newest file in `docs/beta/evidence/b7/`. Its front matter validates against
  [`docs/beta/evidence-schema.json`](../beta/evidence-schema.json).

## Self-tests

Each script has a hermetic `--self-test` that uses no Docker, network or credentials:

```sh
deploy/prod/backup/backup.sh --self-test     # retention (both modes), off-box config, manifest, dotenv, dates, recipients
deploy/prod/backup/ops/setup-box.sh --self-test               # values, the written file, dry run, idempotence
deploy/prod/backup/ops/generate-age-identities.sh --self-test # files, modes, idempotence, no private key printed
scripts/ops/restore-drill.sh --self-test     # every production guard and the dry run, against a fake docker
scripts/ops/restore-drill-ec2.sh --self-test     # the instance side: identity fetch, evidence upload, no leak
scripts/ops/restore-drill-launch.sh --self-test  # the workflow side: preflight, launch, wait, terminate, collect, report
```
