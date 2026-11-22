<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Backup operator scripts

Two scripts for setting up the off-box backup once (BKP-L1, #7243). The full background is in
[`docs/ops/restore-runbook.md`](../../../../docs/ops/restore-runbook.md). Use this page for the
steps.

| Script | Runs on | Does |
|---|---|---|
| `generate-age-identities.sh` | the operator's machine | creates the three age identities and prints only their public keys |
| `setup-box.sh` | the production box, as root, over SSH | installs age, writes `/etc/alethia/backup.env`, installs and enables the timers, takes the first copy, checks it |

Both scripts are safe to run again, take `--dry-run`, print no secret, and have a hermetic
`--self-test`.

## Before you start

- The backup code is on `main` and deployed (BKP-0), so `/opt/alethia/deploy/prod/backup/` exists on
  the box.
- The `infra/backup-account` stack (BKP-S1) is applied. You have its outputs: the bucket name and the
  KMS key ARN.
- The writer key is minted and in the vault (runbook, setup steps 4 and 5).
- You have `age` locally (`brew install age` or `apt-get install age`) and SSH access to the box as
  root.

## 1. Create the three identities (your machine)

Choose a directory **outside any repository**. The script refuses one inside a git work tree.

```sh
deploy/prod/backup/ops/generate-age-identities.sh --out ~/alethia-backup-keys --dry-run
deploy/prod/backup/ops/generate-age-identities.sh --out ~/alethia-backup-keys
```

The output is three public keys and one line to copy:

```text
primary     age1…
breakglass  age1…
drill       age1…

BACKUP_AGE_RECIPIENTS="age1… age1… age1…"
```

The private keys are in `~/alethia-backup-keys/alethia-backup-{primary,breakglass,drill}.agekey`
(0600, in a 0700 directory). Run it again and it prints the same keys; it never overwrites an
identity. Then:

1. Store `primary` in the password manager.
2. Store `breakglass` in the password manager **and** in a second, separate place.
3. Put the contents of `drill` into the backup account's Secrets Manager secret the stack created.
4. Delete `~/alethia-backup-keys`.

## 2. Write the values file (your machine)

Create `values.env` with mode 0600, outside any repository. Use the keys of
[`../backup.env.example`](../backup.env.example):

```sh
BACKUP_S3_ENDPOINT=https://s3.eu-central-1.amazonaws.com
BACKUP_S3_REGION=eu-central-1
BACKUP_S3_PROVIDER=AWS
BACKUP_S3_BUCKET=<stack output>
BACKUP_S3_ACCESS_KEY_ID=<writer key id>
BACKUP_S3_SECRET_ACCESS_KEY=<writer secret>
BACKUP_S3_SSE_KMS_KEY_ID=<stack output: the KMS key ARN>
BACKUP_RETENTION=bucket
BACKUP_AGE_RECIPIENTS="<the line from step 1>"
```

The setup script refuses the file before it changes anything if a required key is missing, if there
are fewer than three recipients, if a recipient is not an age public key, if the KMS key ARN is
missing in bucket mode on AWS, or if a value holds a quote, backslash, `$`, backtick or newline.

**Why a file and not the vault:** the box has no AWS credential. The deploy reads `alethia/prod/env`
in CI over OIDC and ships only the assembled `.env`, so the box cannot read the vault itself. The
values go over the SSH connection on stdin and are not stored on the box anywhere except in
`backup.env`.

## 3. Dry run on the box

```sh
ssh root@<box> /opt/alethia/deploy/prod/backup/ops/setup-box.sh --values - --dry-run < values.env
```

It validates the values, lists which keys are set (names only), and prints what it would install and
run. It changes nothing.

## 4. Run it

```sh
ssh root@<box> /opt/alethia/deploy/prod/backup/ops/setup-box.sh --values - < values.env
```

It runs five steps and stops at the first failure:

1. **values**: validated, as in step 2.
2. **age**: installed with `apt-get` if it is missing.
3. **`/etc/alethia/backup.env`**: written root:root 0600. If the values have not changed, the file is
   not touched.
4. **systemd units**: the four units are copied to `/etc/systemd/system/` if they differ, and both
   timers are enabled and started.
5. **first copy and status**: `systemctl start alethia-backup.service` waits for the nightly job to
   finish, then `backup.sh status` must exit 0.

The last line is `RESULT: PASS` (exit 0) or `RESULT: FAIL (<step>)` (exit 1). The first copy can take
a while; it is the whole database and every SeaweedFS bucket. It is also the first real test of the
uploads into the Object Lock bucket.

## 5. After it passes

1. Delete `values.env` and the writer key file. The secret is now only in the vault and on the box.
2. Run the first restore drill (runbook, "The restore drill").

## If it fails

- **FAIL (values)**: the message above it names the key. Fix `values.env` and run again.
- **FAIL (first backup)**: on the box, `journalctl -u alethia-backup.service -n 50`. A refused upload
  or a hash error usually means a wrong bucket, KMS key ARN or writer key, or a box address missing
  from the writer's allowed source addresses.
- **FAIL (backup.sh status exited 2)**: the store could not be read with the writer key. Check the
  same settings.

Fix the cause and run step 4 again. Nothing it did needs undoing first.

## Changing a value later

Run step 4 again with the new `values.env`. Add `--no-first-run` to skip the extra copy, for example
when rotating the writer key (runbook, "Rotating the writer key").

## Self-tests

```sh
deploy/prod/backup/ops/setup-box.sh --self-test
deploy/prod/backup/ops/generate-age-identities.sh --self-test
```

They use a temporary directory and stand-in commands. No Docker, no network, no root, no real key.
