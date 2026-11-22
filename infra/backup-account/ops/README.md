<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# backup-account operator runbook

The one-time steps that bring up the `alethia-backup` account. Run them in order, from a checkout of
`dev` or `main` that contains `infra/backup-account/`, in a session that holds IaC permissions. Agents
in the main repo session do not run these scripts: `guard-iac.sh` and `guard-spend.sh` refuse the
applies and the account writes.

Every script:

- takes `--dry-run`, which changes nothing anywhere (03 and 04 still READ AWS, to check),
- can be re-run after success; it then reports what already exists and does nothing,
- never prints, logs or puts on a command line a secret,
- is `set -euo pipefail` and shellcheck-clean (CI runs shellcheck on every PR touching this stack).

Never run any of them with `bash -x` or `set -x`.

## What you need

| Tool | Why |
|---|---|
| `aws` CLI v2, `jq` | every step |
| `tofu` >= 1.10 | step 2 |
| A management-account profile | steps 1 and 2 (bootstrap only). A local profile name; never committed |
| `alethia-sso` profile | the platform account's SSO session: both state backends, the vault, and assuming `alethia-backup-admin` |

## Step 1: create the account

```sh
cd infra/backup-account/ops
./01-create-account.sh --management-profile <mgmt> --root-email <fresh address> \
  --sso-principal-id <identity-center user or group id> --dry-run
./01-create-account.sh --management-profile <mgmt> --root-email <fresh address> \
  --sso-principal-id <identity-center user or group id>
```

The script checks that the profile belongs to the organization's management account. It creates
`alethia-backup`, with no billing access for IAM users, and waits for it. Then it assigns the
`AdministratorAccess` permission set to the principal on the new account. It prints the account ID.

Then:

1. Add `backup_account_id = "<id>"` to `infra/backup-account/terraform.tfvars` and open a one-line PR
   into `dev`. Until it lands, the later scripts take `--account-id <id>`.
2. Copy `bootstrap/terraform.tfvars.example` to `bootstrap/terraform.tfvars` (gitignored). Fill in
   the account ID and your SSO role ARN, path included:
   `AWS_PROFILE=alethia-sso aws iam list-roles --path-prefix /aws-reserved/ --query 'Roles[].Arn'`.
3. Create the two gitignored inputs of the main stack, as in `terraform.tfvars.example`:
   - `emails.auto.tfvars`: `budget_alert_emails`.
   - `box.auto.tfvars`: `writer_source_cidrs`, the production box's IPv4 `/32` and IPv6 address. Print
     them on the box.

## Step 2: bootstrap, then the main stack

```sh
./02-bootstrap-and-apply.sh --management-profile <mgmt> --account-id <id>            # plan only
./02-bootstrap-and-apply.sh --management-profile <mgmt> --account-id <id> --apply    # bootstrap
./02-bootstrap-and-apply.sh --management-profile <mgmt> --account-id <id>            # plan main
./02-bootstrap-and-apply.sh --management-profile <mgmt> --account-id <id> --apply    # main
```

Without `--apply`, the script runs `init` and `plan` and prints the plan. With `--apply`, it applies
exactly the saved plan it printed. The main stack applies **through** the role that the bootstrap
creates. So if the bootstrap still has changes, the script stops before the main stack. Run it again
after the bootstrap apply.

Read the main plan before applying it. You should see:

- the bucket `alethia-prod-backup-<id>` with `object_lock_enabled = true`,
- `COMPLIANCE` / `15` in the Object Lock configuration,
- a writer policy that grants only `s3:PutObject`, `s3:GetObject`, `s3:ListBucket` and
  `kms:GenerateDataKey` / `kms:Decrypt`,
- no `aws_iam_access_key`.

> **Object Lock COMPLIANCE cannot be undone.** After the first upload, nobody can delete a locked
> object version for 15 days, root included. The bucket cannot be deleted until every version has
> aged out. That is the point.

## Step 3: check the live posture (read-only)

```sh
./04-verify.sh --account-id <id>
```

The script prints PASS or FAIL for: Object Lock (COMPLIANCE, 15 days), versioning, SSE-KMS with a
Bucket Key, the public-access block, the TLS-only policy, the writer's policies (one inline policy,
no Delete action, and the IAM simulator denies delete and retention changes), the KMS key (Enabled,
rotation on) and the drill secret. Do not continue on a FAIL.

## Step 4: mint the writer key into the vault

```sh
./03-mint-writer-key.sh --account-id <id> --dry-run
./03-mint-writer-key.sh --account-id <id>
```

The script creates the `backup-writer` access key. It merges `BACKUP_S3_ACCESS_KEY_ID` and
`BACKUP_S3_SECRET_ACCESS_KEY` into `alethia/prod/env` (eu-central-1, platform account) and keeps
every other key. It prints only the last four characters of the key ID.

If the vault already holds an active writer key, the script does nothing. **Yearly rotation:**
`--rotate`. That mints a second key and points the vault at it. Once the box has the new key,
deleting the old one is the maintainer's job.

## Step 5: the box, and the drill identity

These steps are outside these scripts. Each needs a human, offline key material, or the box:

1. **Age identities, offline:** `age-keygen` three times: `primary`, `breakglass` and `drill`. Keep
   the first two in the password manager, and keep the break-glass copy in a second place too. Put
   the `drill` identity into the secret the stack created. Do not put it on a command line. Use the
   console, or `aws secretsmanager put-secret-value --secret-id alethia/backup/drill-age-identity
   --secret-string file://<path>` as `alethia-backup-admin`, then delete the file.
2. **On the box** (once BKP-0 and BKP-L1 are on `main`): write `/etc/alethia/backup.env` (0600). The
   non-secret values come from `cd infra/backup-account && tofu output backup_env`. The two key values
   come from the vault. Add the three **public** keys to `BACKUP_AGE_RECIPIENTS`. Then install and
   enable the two timers and run the first copy plus `backup.sh status`. The steps are in
   `docs/ops/restore-runbook.md`.

## If something goes wrong

- **Step 1 times out:** re-run it. It picks up the account once it is ACTIVE.
- **Step 2 cannot assume `alethia-backup-admin`:** the bootstrap is not applied, or your SSO role ARN
  in `bootstrap/terraform.tfvars` is wrong.
- **Step 4 says a key exists that the vault does not hold:** a key was minted but not recorded. The
  maintainer removes it in the IAM console, then you re-run.
- **Nothing here deletes anything.** Deletion in this account is the maintainer's, by hand.
