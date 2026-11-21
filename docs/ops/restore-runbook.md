<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Off-box backup and restore runbook

This runbook covers the production box's off-box backup, the scripted restore drill, and what a real
recovery adds to the drill. It is the operator half of board unit REL-L7 (#6908) and the instrument
behind two of the three parts of beta predicate **B7** ([`docs/beta/README.md`](../beta/README.md)).

| B7 part | Instrument | Passes when |
|---|---|---|
| Off-box backup | `deploy/prod/backup/backup.sh status` | the newest complete daily copy is less than 26 hours old (exit 0) |
| Restore drill | `scripts/ops/restore-drill.sh` and the record it writes | the newest record in `docs/beta/evidence/b7/` has `verdict: pass`, `tombstonesReplayed: true`, a `durationSeconds`, and a `date` within 45 days |

Nothing here runs by itself until the maintainer completes [the one-time setup](#one-time-setup-maintainer-dec-1).
Everything that creates a resource, holds a credential or touches the production box is the
maintainer's.

## What is backed up, and where it goes

Production is one box (`deploy/prod/README.md`). Postgres and SeaweedFS live on its data volume, and
Hetzner's own server backups are the only other copy, held by the same provider. The off-box backup
adds a copy at a **second provider**:

| What | How | Why |
|---|---|---|
| Postgres | `pg_dump -Fc` inside the running postgres container, streamed into `age` | a logical dump restores onto any Postgres 17, not only onto the same disk |
| SeaweedFS | every bucket (customer tofu state and plan artefacts), copied by an rclone container on the compose network, then `tar`, `gzip` and `age` | losing a customer's tofu state loses their infrastructure's record |
| Erasure tombstones | `privacy_erasure_tombstone` as CSV, in every daily copy **and** hourly on its own | see [Tombstones](#tombstones-why-there-is-an-hourly-export) |

Every file is encrypted to one or more age **public** keys before it leaves the box. The private keys
are never on the box, so a compromised box can write a backup but cannot read one. The store's layout,
under `<bucket>/<BACKUP_PREFIX>/`:

```text
daily/<YYYYMMDDTHHMMSSZ>/postgres.dump.age
                         storage.tar.gz.age
                         tombstones.csv.age
                         manifest.json          written last: no manifest means not a backup
weekly/<YYYY-Www>/…                             first complete daily of each ISO week
latest.json                                     names the newest complete daily
tombstones/latest.csv.age, tombstones/latest.json   rewritten every hour
```

Retention is 14 dailies and 8 weeklies (`BACKUP_KEEP_DAILY`, `BACKUP_KEEP_WEEKLY`). It runs only after
that night's copy is complete, so a failing night never deletes anything. A copy without a manifest
that is newer than the oldest kept copy is left alone, because it may still be uploading.

The nightly runs at 02:30 UTC (`alethia-backup.timer`); the tombstone export runs hourly
(`alethia-backup-tombstones.timer`). A missed slot runs at the next boot (`Persistent=true`). One
missed night is already a failing B7, because the window is 26 hours.

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

## One-time setup (maintainer, Dec 1)

This is the "Provision off-box backup storage and its credentials" action of the beta plan. It needs
this unit merged to `main` and deployed, so that `/opt/alethia/deploy/prod/backup/` exists on the box.

1. **Choose the store.** An S3-compatible object store at a provider that is not Hetzner, in the EU.
   Create one bucket for these backups only. Turn on object versioning if the provider offers it.
2. **Create two keys scoped to that bucket.**
   - The **box key**: read, write, list and delete. Retention deletes, so this key needs delete.
   - The **drill key**: read and list only.
3. **Create two age identities**, offline, on your own machine:

   ```sh
   age-keygen -o alethia-backup-primary.agekey      # prints "Public key: age1…"
   age-keygen -o alethia-backup-breakglass.agekey
   ```

   Keep both private key files in your password manager. Keep the break-glass one in a second place.
   Losing every identity makes every backup unreadable; there is no recovery from that.
4. **Put the two secret values in the vault** (`alethia/prod/env`): `BACKUP_S3_ACCESS_KEY_ID` and
   `BACKUP_S3_SECRET_ACCESS_KEY` for the box key, so they outlive the box. The deploy does not read
   them; the box reads its own file in step 6.
5. **On the production box**, install age:

   ```sh
   apt-get install -y age
   ```

6. **Write `/etc/alethia/backup.env`** from `deploy/prod/backup/backup.env.example`: the store, the box
   key, and both age **public** keys in `BACKUP_AGE_RECIPIENTS`, separated by a space. Then:

   ```sh
   chown root:root /etc/alethia/backup.env && chmod 600 /etc/alethia/backup.env
   ```

7. **Install and start the timers:**

   ```sh
   cd /opt/alethia/deploy/prod/backup
   install -m 0644 alethia-backup.service alethia-backup.timer \
     alethia-backup-tombstones.service alethia-backup-tombstones.timer /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now alethia-backup.timer alethia-backup-tombstones.timer
   ```

8. **Take the first copy now** and confirm it:

   ```sh
   systemctl start alethia-backup.service          # waits until it finishes
   journalctl -u alethia-backup.service -n 50
   set -a; . /etc/alethia/backup.env; set +a
   /opt/alethia/deploy/prod/backup/backup.sh status   # exit 0 and "verdict":"pass"
   ```

   The temporary bucket copy is written to `$BACKUP_WORKDIR` (default: the system temp directory), so
   that directory needs room for one copy of the SeaweedFS buckets.

9. **Perform the first drill**, below, and commit its record.

## The restore drill

The drill restores the newest copy onto a throwaway box, times it from an empty box to a console whose
readiness body says `healthy`, and writes the B7 record. It costs about EUR 1. Run it once by Dec 1 and
again at the release candidate. It must be newer than 45 days for B7 to pass.

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

Steps:

1. Note the time, so the record can include the box's creation: `T0=$(date -u +%s)`.
2. Create a throwaway server in the Hetzner project: x86 (the production images are `linux/amd64`),
   `ubuntu-24.04`, with a firewall that allows SSH only. Size it like production (`cx33`).
3. On it, install Docker and age, and check out the repository at the commit you want to drill with:

   ```sh
   curl -fsSL https://get.docker.com | sh
   apt-get install -y age
   git clone https://github.com/alethialabs-io/alethialabs /root/alethia && cd /root/alethia
   ```

4. Copy two files to the box, each with mode 0600: a `backup.env` holding the store and the **drill**
   (read-only) key, and one age identity file.
5. Dry run. It checks the box and the listing, prints the plan and changes nothing:

   ```sh
   scripts/ops/restore-drill.sh --target drill --env-file /root/backup.env
   ```

6. Run it:

   ```sh
   scripts/ops/restore-drill.sh --target drill --execute \
     --env-file /root/backup.env --age-identity /root/primary.agekey --started-at "$T0"
   ```

   With no `--image-tag`, it restores with the console image that was running when the backup was
   taken (the manifest's `sourceCommit`). If that image predates `replay-tombstones.ts`, the script
   mounts this checkout's copy and runs it against the image's own erasure register.
7. The script writes `docs/beta/evidence/b7/<date>-restore-drill.md` and a `.log` beside it, on pass
   or fail. Copy both off the box and open a PR into `dev` with them.
8. Delete the identity file and the `backup.env`, then **delete the server**. The box held restored
   production data.

A failed drill also writes a record, with `verdict: fail` and the step that failed. It does not count
for B7. Fix the cause and run the drill again on a new box.

## A real recovery (box lost)

This part has not been drilled. The drill script refuses production-shaped targets on purpose, so a
real recovery runs the same steps by hand:

1. Provision the new box with `infra-cp-hetzner` (maintainer). Do **not** run the deploy yet: its
   first `compose up` would migrate an empty database and start serving it.
2. On the new box, check out the commit named in the manifest's `sourceCommit`. Write `/opt/alethia/.env`
   with the values the deploy would write: the keys `scripts/ci/deploy-console-assemble-env.sh` emits,
   from the vault. The restored console needs production's real secrets, including the credential
   encryption key, or every stored credential stays unreadable.
3. Start only `postgres` and `seaweedfs` with the production compose files. Follow the drill's steps
   4 to 6 against project `alethia`: `pg_restore`, load the buckets, run `migrate`, merge and replay the
   tombstones, and check that none is left.
4. Run the deploy. Its `compose up` starts the console on the restored data.
5. Run `backup.sh status` on the new box after the next nightly, and re-install the timers.

## Checking B7

- **Backup:** `backup.sh status` prints one JSON line. Exit 0 is fresh, 1 is older than 26 hours, and
  2 means the store could not be read. Exit 2 is not "no backup": it means nothing was measured.
- **Drill:** the newest file in `docs/beta/evidence/b7/`. Its front matter validates against
  [`docs/beta/evidence-schema.json`](../beta/evidence-schema.json).

## Self-tests

Both scripts have a hermetic `--self-test` that uses no Docker, network or credentials:

```sh
deploy/prod/backup/backup.sh --self-test     # retention, manifest readers, dotenv reader, dates, recipients
scripts/ops/restore-drill.sh --self-test     # every production guard and the dry run, against a fake docker
```
