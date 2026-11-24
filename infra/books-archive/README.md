<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# books-archive

The immutable archive for Alethia Labs' books: every monthly accountant package and every document
that only the console holds (фактури, credit notes, PDFs). It lives in the existing `alethia-backup`
AWS account (`450956683176`, eu-central-1). Its state is in `alethia-tofu-state-270587882865`, key
`books-archive/terraform.tfstate`. The design is in the management repo,
`spec/features/beta-2027-01-31/books-automation.md` (summary item 8). This is books lane B1.

An operator applies this stack by hand, because it creates IAM. CI only validates it
(`.github/workflows/infra-books-archive.yml`: fmt, validate, `tofu test`, shellcheck, tflint, Trivy).
CI uses no credentials and no `id-token`.

## What it creates

| Resource | Purpose |
|---|---|
| `alethia-books-archive-<account>` (S3) | Object Lock **COMPLIANCE, 4018 days (11 years)**, versioning, SSE-KMS with a Bucket Key, all four public-access blocks, `BucketOwnerEnforced`, `prevent_destroy`. Its one lifecycle rule aborts incomplete multipart uploads. Nothing expires. |
| Bucket policy | TLS only. Answers only the admins, `books-monthly` and `console-books-writer`. Denies delete, retention, legal-hold, governance-bypass and bucket-configuration changes to everyone except the admins. |
| `alias/alethia-books-archive` (KMS) | Key rotation is on, the deletion window is 30 days, `prevent_destroy`. The key policy denies `ScheduleKeyDeletion`, `DisableKey` and `PutKeyPolicy` to everyone except the admins. |
| `books-monthly` (IAM role) | Trusts the account's **existing** GitHub OIDC provider (which `infra/backup-account` owns), and only for `repo:alethialabs-io/books:environment:books`. It can put under `records/` and get and list under `inbound/` and `records/`. It can use KMS through S3 only, and `GetSecretValue` on `alethia/books/connectors` only. |
| `console-books-writer` (IAM user, `/alethia-books/`) | Can put under `inbound/console/` only, and only from the production box's addresses (`aws:SourceIp`). It cannot read, list or delete. **There is no access key in this stack.** |
| `alethia/books/connectors` (Secrets Manager) | A shell with no value. Its resource policy lets only `books-monthly` and the admins read it, and only the admins replace, delete or re-policy it. |
| `alethia-books-archive-monthly` (budget) | USD 5 a month. It counts only this stack's resources, through the `role = books-archive` tag (see [Cost](#cost)). |

"Admins" means the `alethia-backup-admin` role (from `infra/backup-account/bootstrap`) and the
Identity Center `AdministratorAccess` roles in this account.

> **Object Lock COMPLIANCE cannot be undone.** No one can delete a version for 4018 days after it is
> written, and that includes root. No one can delete the bucket while it holds a locked version. Every
> object written is stored, and paid for, for 11 years.

## Residual risk: writes cannot be taken back

Object Lock works in both directions. A stolen `console-books-writer` key, used from the box, or a
compromised `books` environment can upload data that no one can delete for 11 years, and it is
billed for those 11 years. S3 has no bucket-policy condition that limits a `PutObject` by size. The
controls are the narrow grants (one prefix each, and the writer is locked to the box's addresses)
and the budget, which alerts at USD 2.50 once its tag is active (see [Cost](#cost)). If you see
unexpected growth, revoke the key first: `aws iam update-access-key --status Inactive`.

## No secret in the state

`checks.tf` scans every `*.tf` file. It refuses `aws_iam_access_key`, `aws_iam_user_login_profile`,
`aws_iam_service_specific_credential`, `aws_iam_signing_certificate` and
`aws_secretsmanager_secret_version`. `checks.tftest.hcl` proves that the stack is clean and that the
patterns match. `ops/plan.sh` also refuses a plan that would create any of these.

## Inputs

`terraform.tfvars` is committed and holds only public values. Two inputs are never committed. Both
are required, so the plan fails loudly without them (see `terraform.tfvars.example`):

- `emails.auto.tfvars`: `budget_alert_emails`.
- `box.auto.tfvars`: `console_writer_source_cidrs`, the production box's egress addresses. **This repo
  does not record them.** The box's origin sits behind the Cloudflare tunnel. Use the same values as
  `writer_source_cidrs` in `infra/backup-account/box.auto.tfvars`, or print them on the box with
  `curl -4 -s https://checkip.amazonaws.com; curl -6 -s https://api64.ipify.org`. If the box is
  re-provisioned with a new address, the console's exports fail until you update this input and
  apply again.

## Operator steps

Run from a checkout of `dev` or `main`, with the `alethia-sso` profile signed in. The scripts never
print a secret. Never run them with `bash -x` or `set -x`.

```sh
cd infra/books-archive
# first: create emails.auto.tfvars and box.auto.tfvars as terraform.tfvars.example shows

ops/plan.sh              # tofu init + tofu plan -out=tfplan + a human summary
ops/apply-saved-plan.sh  # tofu apply tfplan: exactly the plan you read, nothing else
ops/mint-console-writer-key.sh --dry-run
ops/mint-console-writer-key.sh
```

`plan.sh` exits with a non-zero code and removes the saved plan in these cases:

| Exit | Cause |
|---|---|
| 3 | The plan deletes or replaces a resource. |
| 4 | The plan creates a credential. |
| 5 | A `check` block warned. |

`apply-saved-plan.sh` checks the saved plan again before it applies it. Before you apply, confirm
these in the summary:

- `COMPLIANCE / 4018 days`.
- The writer has only `s3:PutObject` on `inbound/console/*`.
- The trust subject is `repo:alethialabs-io/books:environment:books`.

`mint-console-writer-key.sh` creates the writer's key and merges it into the production vault
`alethia/prod/env` as `BOOKS_ARCHIVE_ACCESS_KEY_ID` and `BOOKS_ARCHIVE_SECRET_ACCESS_KEY`. The key
goes from file to file and never appears in argv, the environment or the terminal. The script can be
run again safely. Use `--rotate` for the yearly rotation. The values that are not secret come from
`tofu output console_env`.

### Fill the connectors secret

From an admin SSO session in the backup account, write the JSON from a file. Never pass the value on
the command line:

```sh
aws secretsmanager put-secret-value --region eu-central-1 \
  --secret-id alethia/books/connectors --secret-string file://connectors.json
rm connectors.json
```

### Wire the books repository

In `alethialabs-io/books`, open the `books` environment (deployment branch: `main` only). Set the
`AWS_ROLE_ARN` variable to `tofu output -raw books_monthly_role_arn` and set the bucket name and
region. Only jobs that declare `environment: books` can assume the role.

## Cost

These are estimates from AWS list prices for eu-central-1. They are not a measurement.

| Item | USD per month |
|---|---|
| KMS customer-managed key | 1.00 |
| Secrets Manager secret | 0.40 |
| S3 Standard storage, about 1 GB in the first years at 0.0245 per GB | about 0.03 |
| S3 requests and KMS requests (Bucket Key) | under 0.05 |
| Budget (the account's second budget, which is free) | 0 |
| **Total** | **about 1.5** |

Storage grows by each month's package and never shrinks, because Object Lock keeps every version.
At a few MB a month, it stays well under USD 0.10 for the whole 11 years.

**The budget needs one step outside this stack.** The budget filters on the cost allocation tag
`user:role$books-archive`. AWS counts tagged costs only after `role` is an **active cost allocation
tag** in the organization's payer account (Billing, then Cost allocation tags). Until then, the budget
reads USD 0 and never alerts. To check, open the budget in the console about 24 hours after you
activate the tag. It should show a spend that is not zero, about USD 1 for the KMS key.

## Not in this stack

- The GitHub OIDC provider. `infra/backup-account` owns it, and this stack reads it as a data source.
  If the provider is missing, `tofu plan` fails.
- The console's export (books lane B2) and the books workflow (lanes B4 and B5). They use the
  identities this stack creates.
