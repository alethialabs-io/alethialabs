# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The immutable books archive (books lane B1): the store every monthly accountant package and every
# document the console alone holds (фактури, credit notes, PDFs) is kept in for the statutory
# retention period. In the existing `alethia-backup` account (eu-central-1). Design: management repo,
# spec/features/beta-2027-01-31/books-automation.md, summary item 8.
#
#   kms.tf      the customer key the bucket is encrypted with (rotation, prevent_destroy, a key policy
#               that refuses ScheduleKeyDeletion / DisableKey / PutKeyPolicy to everyone but admins)
#   bucket.tf   versioning + Object Lock COMPLIANCE 4018 d + SSE-KMS (Bucket Key) + public-access
#               block + BucketOwnerEnforced + a TLS-only, principal-restricting policy + lifecycle
#               that only aborts abandoned multipart uploads (nothing EVER expires)
#   oidc.tf     books-monthly: the role the private `books` repo's workflow assumes through the
#               account's EXISTING GitHub OIDC provider, bound to one GitHub environment
#   writer.tf   console-books-writer: the production box's IAM user. PutObject under inbound/console/
#               only, SourceIp-locked, NO access key in this stack
#   secret.tf   the Secrets Manager secret SHELL for the books connectors (no value)
#   budget.tf   a USD 5 monthly budget scoped to this stack's resources by tag
#
# What it deliberately does NOT do:
#   · mint the writer's access key, or put a value into the connectors secret. Both would write a
#     secret into the state. ops/mint-console-writer-key.sh does the first; the maintainer the second.
#   · create the GitHub OIDC provider. infra/backup-account owns it; this stack reads it.

locals {
  bucket_name = "alethia-books-archive-${var.backup_account_id}"
  bucket_arn  = "arn:aws:s3:::${local.bucket_name}"

  # The archive's layout. records/ is what the books workflow files (months/YYYY-MM/… packages);
  # inbound/ is what arrives FROM elsewhere, and inbound/console/ is the one part the console writes.
  records_prefix         = "records/"
  inbound_prefix         = "inbound/"
  console_inbound_prefix = "inbound/console/"

  # ── Retention, as CONSTANTS ───────────────────────────────────────────────────────────────────
  # Not variables: each is a legal decision, so changing one is a reviewed diff that
  # checks.tftest.hcl reads.
  #
  #   lock_mode  COMPLIANCE: no principal, root included, can delete or shorten a locked version
  #              before its retain-until date, and the mode can never be relaxed to GOVERNANCE.
  #   lock_days  4018 = 11 years (11 × 365 + 3 leap days), the period the books-automation plan
  #              fixes (summary item 6: "S3 Object Lock (COMPLIANCE, 11 years)"). Counted from each
  #              upload, so a document archived late in a year is still covered for the whole
  #              statutory period that starts after that year. Whether 11 years is the right figure
  #              is the accountant's to confirm, not this file's; lengthening it later is possible
  #              per object, shortening a locked version never is.
  #   abort_multipart_days  an upload left incomplete is aborted after this (neither writer holds
  #              s3:AbortMultipartUpload). The ONLY lifecycle action on the bucket.
  lock_mode            = "COMPLIANCE"
  lock_days            = 4018
  abort_multipart_days = 1

  # Names, built rather than read off resources so every policy renders in full on the FIRST plan —
  # the one the maintainer most needs to read. checks.tf compares each with the real ARN once known.
  books_role_name     = "books-monthly"
  books_role_arn      = "arn:aws:iam::${var.backup_account_id}:role/${local.books_role_name}"
  writer_user_name    = "console-books-writer"
  writer_user_path    = "/alethia-books/"
  writer_user_arn     = "arn:aws:iam::${var.backup_account_id}:user${local.writer_user_path}${local.writer_user_name}"
  admin_role_arn      = "arn:aws:iam::${var.backup_account_id}:role/${var.backup_admin_role_name}"
  sso_admin_role_like = "arn:aws:iam::${var.backup_account_id}:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_${var.sso_admin_permission_set}_*"

  # The principals that administer the archive: the apply role and the Identity Center admins. Only
  # these may change the bucket's configuration or policy, the key's state or policy, or read the
  # connectors secret besides books-monthly.
  admin_principal_patterns = [local.admin_role_arn, local.sso_admin_role_like]

  # Everyone the bucket answers at all. Anything else in the account — the backup stack's own
  # identities and the management account's OrganizationAccountAccessRole included — is denied
  # every S3 action on it.
  bucket_principal_patterns = concat(local.admin_principal_patterns, [
    local.books_role_arn,
    local.writer_user_arn,
  ])

  # The key is named in IAM by its ALIAS (kms:ResourceAliases), not its ARN, so every policy naming
  # it renders on the first plan (the same reasoning as infra/backup-account/main.tf).
  kms_alias_name      = "alias/alethia-books-archive"
  kms_key_arn_pattern = "arn:aws:kms:${var.region}:${var.backup_account_id}:key/*"

  # Secrets Manager appends a random 6-character suffix to a secret's ARN.
  connectors_secret_name        = "alethia/books/connectors"
  connectors_secret_arn_pattern = "arn:aws:secretsmanager:${var.region}:${var.backup_account_id}:secret:${local.connectors_secret_name}-??????"

  s3_via_service = "s3.${var.region}.amazonaws.com"
  s3_endpoint    = "https://s3.${var.region}.amazonaws.com"

  # The value of the `role` default tag, and the budget's cost filter on it.
  cost_tag_value = "books-archive"
}
