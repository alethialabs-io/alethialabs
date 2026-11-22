<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# backup-account

Off-box production backups, in a dedicated AWS account: **`alethia-backup`**, `eu-central-1`. It is a
member of the same AWS Organization as the platform account (270587882865), like `alethia-email` and
`alethia-e2e`. A backup in the production account would be reachable by every principal that can
reach the production vault and the deploy roles. This account exists so that it is not.

The box (`deploy/prod/backup/backup.sh`) encrypts every copy with age before upload, so nothing at
AWS can read it. This stack makes sure that nothing that can reach the box can **remove** a copy
either.

**To bring it up, follow [`ops/README.md`](ops/README.md).** CI only validates this stack. Nothing
applies it automatically.

| File | What |
|---|---|
| `bootstrap/` | One role, `alethia-backup-admin`, that the main stack applies through. Applied **once** with the organization's management-account credentials. Same shape as `infra/email-ses-account/bootstrap`. |
| `provider.tf` | Assumes `alethia-backup-admin`. `allowed_account_ids = [backup_account_id]`. |
| `kms.tf` | The customer key for the bucket and the drill secret. Rotation on, 30-day deletion window, `prevent_destroy`. |
| `bucket.tf` | `alethia-prod-backup-<account>`: versioning, **Object Lock COMPLIANCE 15 days**, SSE-KMS with a Bucket Key, all four public-access blocks, `BucketOwnerEnforced`, a TLS-only and principal-restricting policy, lifecycle (daily 15 d, weekly 60 d, evidence 30 d, noncurrent 16 d). `prevent_destroy`. |
| `writer.tf` | `backup-writer`: the box's IAM user. `s3:PutObject` / `s3:GetObject` / `s3:ListBucket` on `<prefix>/`, KMS only through S3, and nothing from outside `writer_source_cidrs`. **No delete. No access key in this stack.** |
| `oidc.tf` | The account's GitHub OIDC provider. `backup-reader` (the freshness monitor, BKP-L2) and `drill-launcher` (the weekly drill, BKP-L3). Both trust only `repo:alethialabs-io/alethialabs:ref:refs/heads/main`. |
| `drill.tf`, `drill-user-data.sh.tftpl` | The drill: an egress-only VPC, a security group with no ingress, the `restore-drill` instance role, a spot launch template (IMDSv2, encrypted disk, no key pair, terminate on power-off) and the Secrets Manager **shell** for the drill's age identity. |
| `budget.tf` | A monthly cost budget with email alerts. |
| `checks.tf`, `checks.tftest.hcl` | Invariants and the credential-free posture test. CI runs them in `.github/workflows/infra-backup-account.yml`. |
| `ops/` | The operator scripts and their runbook. |

## Design decisions

The design is in the management repo, `spec/features/beta-2027-01-31/backups-and-mail.md` §A.3. The
maintainer accepted it on 2026-11-22. What follows is how this stack implements it, and where it had
to choose.

**Who can delete.** No identity this stack creates can delete an object, add a delete marker, or change
retention or a legal hold: not the writer, the reader, the launcher or the drill. The bucket policy
also denies those actions, and changes to the bucket's own configuration, to everyone except
`alethia-backup-admin` and the account's Identity Center `AdministratorAccess` roles. It denies
**every** S3 action to all other principals, including the management account's
`OrganizationAccountAccessRole`. Inside the 15-day window, Object Lock COMPLIANCE refuses deletion even
to those admins and to root. The bucket policy is repairable: S3 always lets the account's root user
delete a bucket policy.

**Retention is the bucket's job.** Lifecycle expires `daily/` after 15 days and `weekly/` after 60. It
removes a version 16 days after the version stops being current. `noncurrent_days` is greater than
the lock period, so lifecycle never targets a version that is still locked. The box keeps no delete
right. `BACKUP_RETENTION=bucket` (BKP-L1) turns off the script's own pruning. The numbers are
constants in `main.tf`, not variables, so a change is a reviewed diff that the posture test reads.
Expiring a current version leaves it noncurrent for 16 more days. A daily copy is therefore stored
for about 31 days, not 15, and the cost table below allows for that.

**No secret in the state.** The writer's access key is minted by `ops/03-mint-writer-key.sh` straight
into the vault. The drill's age identity is put into its secret by hand. Neither exists as a resource,
and `check.no_credential_or_secret_value_resource` reads every `*.tf` file here (bootstrap included)
and fails on an `aws_iam_access_key`, `aws_iam_user_login_profile`,
`aws_iam_service_specific_credential` or `aws_secretsmanager_secret_version`.

**The key is named by its alias in IAM.** A KMS key ARN carries a random ID that is known only after
apply. Policies naming it would show as `(known after apply)` on the first plan, the plan that most
needs reading. Each grant therefore names `arn:aws:kms:<region>:<account>:key/*` and adds the
condition `kms:ResourceAliases = alias/alethia-prod-backup`, plus `kms:ViaService`. Only the drill's
`RunInstances` grant names a value known only after apply, the launch template's ARN. It sits in its
own policy (`launcher_run`) so the rest of the launcher's grants render on the first plan.

**Where the state lives.** In the platform account's existing state bucket, under
`backup-account/bootstrap/` and `backup-account/`, with the same `alethia-sso` authentication as
`infra/email-ses-account` and `infra/aws-e2e`. The state holds no secret (see above). A principal that
can write that bucket still cannot apply this stack without `alethia-backup-admin`.

**The drill's contract with BKP-L3.** The launch template's user-data is deliberately thin. It first
schedules its own power-off after `drill_max_lifetime_minutes`, and power-off terminates the
instance. It then installs docker, compose, git and age. It writes the non-secret settings to
`/etc/alethia/drill.env`, clones the repository at `main`, and runs **one** entrypoint:
`scripts/ops/restore-drill-ec2.sh --env-file /etc/alethia/drill.env`. BKP-L3 writes that script. The
drill's logic can then change without a new launch template version. The launcher cannot override any
launch parameter (`ec2:IsLaunchTemplateResource`). Until BKP-L3 lands, a launched instance clones,
finds no entrypoint, and powers off.

**The OIDC subject.** Both roles trust `ref:refs/heads/main` exactly. A `schedule` run and a
`workflow_dispatch` from `main` present that subject. If BKP-L2 or BKP-L3 puts its job behind a
GitHub `environment:`, the subject becomes `environment:<name>`, and `github_trust` must change in
the same PR.

**Not done here.** The changes to `backup.sh`, the drill script and the two workflows that use these
identities (BKP-L1, L2, L3). Whether the pinned rclone sends the `Content-MD5` or checksum header that
Object Lock uploads require (BKP-L1 must prove it against this bucket before the first nightly). The
`infra/README.md` stacks table entry, which is outside this unit's scope.

## Cost

These are list prices, about 2 GB per nightly copy, from design §A.5. Confirm them in the AWS
calculator.

| Item | Per month |
|---|---|
| S3 Standard: about 30 dailies held (15 current plus about 16 noncurrent) and 8 to 10 weeklies, so 80 to 90 GB | about USD 2 |
| KMS key (Bucket Key, so few requests) | USD 1 |
| Secrets Manager, one secret | USD 0.40 |
| Drill: about 4 spot instance-hours, a public IPv4 address while running, 60 GB gp3 while running | under USD 1 |
| **Total** | **about USD 4 to 5** |

The VPC, subnet, internet gateway, IAM, OIDC provider and launch template cost nothing while no
instance runs. The budget (`monthly_budget_usd = 15`) emails at 50% and 100% of actual spend, and
at 100% of forecast spend.
