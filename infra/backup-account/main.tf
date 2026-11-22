# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Off-box production backups (BKP-S1): the store, its key, and the identities that may touch it, in
# the dedicated `alethia-backup` account (eu-central-1). Design: management repo,
# spec/features/beta-2027-01-31/backups-and-mail.md §A.3.
#
#   kms.tf      the customer key the bucket is encrypted with (prevent_destroy, 30-day window)
#   bucket.tf   versioning + Object Lock COMPLIANCE 15 d + SSE-KMS (Bucket Key) + public-access block
#               + TLS-only, principal-restricting policy + lifecycle (daily 15 d, weekly 60 d,
#               noncurrent 16 d)
#   writer.tf   backup-writer: the box's IAM user. Put/Get/List only, SourceIp-locked, NO delete,
#               NO access key in this stack
#   oidc.tf     the account's GitHub OIDC provider; backup-reader (freshness monitor) and
#               drill-launcher (weekly restore drill), both bound to one branch
#   drill.tf    the drill's network, instance role, launch template and the age-identity secret SHELL
#   budget.tf   the account's monthly cost budget
#
# What it deliberately does NOT do:
#   · mint the writer's access key, or put a value into the drill secret. Both would write a secret
#     into the state. The maintainer does both out of band (README steps 5 and 6).
#   · change backup.sh, the drill script or any workflow that USES these identities (BKP-L1..L3).

locals {
  bucket_name = "alethia-prod-backup-${var.backup_account_id}"
  bucket_arn  = "arn:aws:s3:::${local.bucket_name}"

  # The layout backup.sh writes (deploy/prod/backup/backup.sh "THE LAYOUT OFF-BOX"), plus the drill's
  # evidence/ prefix beside it.
  daily_prefix    = "${var.backup_prefix}/daily/"
  weekly_prefix   = "${var.backup_prefix}/weekly/"
  evidence_prefix = "evidence/"

  # ── Retention, as CONSTANTS ───────────────────────────────────────────────────────────────────
  # Not variables: each is a decision recorded in the design (decisions A-2, A-3) and the legal
  # texts, so changing one is a reviewed diff here that checks.tftest.hcl reads.
  #
  #   lock_days        Object Lock COMPLIANCE default retention. No principal, root included, can
  #                    delete or shorten a locked version inside it.
  #   daily_days       a daily copy's current version expires after this. >= lock_days, so a daily
  #                    is locked for its whole life (14 kept + one in flight).
  #   weekly_days      a weekly copy's (8 kept + margin).
  #   noncurrent_days  an overwritten or expired version is removed this long after it stops being
  #                    current. > lock_days, so lifecycle never targets a version still locked.
  #   evidence_days    the drill's record and log; the workflow copies the record into the repo.
  lock_mode       = "COMPLIANCE"
  lock_days       = 15
  daily_days      = 15
  weekly_days     = 60
  noncurrent_days = 16
  evidence_days   = 30

  # Names, built rather than read off resources so every policy renders in full on the FIRST plan —
  # the one the maintainer most needs to read. check.* in checks.tf compares each with the real ARN
  # once it is known.
  writer_user_name    = "backup-writer"
  writer_user_path    = "/alethia-backup/"
  writer_user_arn     = "arn:aws:iam::${var.backup_account_id}:user${local.writer_user_path}${local.writer_user_name}"
  reader_role_name    = "backup-reader"
  reader_role_arn     = "arn:aws:iam::${var.backup_account_id}:role/${local.reader_role_name}"
  launcher_role_name  = "drill-launcher"
  launcher_role_arn   = "arn:aws:iam::${var.backup_account_id}:role/${local.launcher_role_name}"
  drill_role_name     = "restore-drill"
  drill_role_arn      = "arn:aws:iam::${var.backup_account_id}:role/${local.drill_role_name}"
  admin_role_arn      = "arn:aws:iam::${var.backup_account_id}:role/${var.backup_admin_role_name}"
  sso_admin_role_like = "arn:aws:iam::${var.backup_account_id}:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_${var.sso_admin_permission_set}_*"

  # The principals that administer the bucket: the apply role and the Identity Center admins. Only
  # these may delete, change retention, lifecycle, versioning, encryption or the bucket policy.
  admin_principal_patterns = [local.admin_role_arn, local.sso_admin_role_like]

  # Everyone the bucket answers at all. Anything else in the account — including the management
  # account's OrganizationAccountAccessRole — is denied every S3 action on it.
  bucket_principal_patterns = concat(local.admin_principal_patterns, [
    local.writer_user_arn,
    local.reader_role_arn,
    local.launcher_role_arn,
    local.drill_role_arn,
  ])

  # The key is named in IAM by its ALIAS (kms:ResourceAliases), not its ARN: a key ARN carries a
  # random id known only after apply, so every policy naming it would render as `(known after apply)`
  # on the first plan. The pattern admits only keys in this account and region; the alias condition
  # narrows it to the one key that carries this alias.
  kms_alias_name      = "alias/alethia-prod-backup"
  kms_key_arn_pattern = "arn:aws:kms:${var.backup_region}:${var.backup_account_id}:key/*"

  # Secrets Manager appends a random 6-character suffix to a secret's ARN.
  drill_secret_arn_pattern = "arn:aws:secretsmanager:${var.backup_region}:${var.backup_account_id}:secret:${local.drill_secret_name}-??????"

  s3_via_service      = "s3.${var.backup_region}.amazonaws.com"
  secrets_via_service = "secretsmanager.${var.backup_region}.amazonaws.com"

  # The value backup.env needs (BKP-L1): the regional endpoint, not the global one.
  s3_endpoint = "https://s3.${var.backup_region}.amazonaws.com"

  drill_tag = { "alethia-role" = "restore-drill" }
}
