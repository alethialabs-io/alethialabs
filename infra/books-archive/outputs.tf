# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# None of these is a secret. The console writer's access key pair is minted outside this stack
# (ops/mint-console-writer-key.sh) and is never an output.

output "backup_account_id" {
  description = "The account the provider actually operated in, read back from STS (not echoed from the variable)."
  value       = data.aws_caller_identity.current.account_id
}

output "bucket_name" {
  description = "The Object-Lock archive bucket."
  value       = aws_s3_bucket.archive.bucket
}

output "kms_key_arn" {
  description = "The archive's customer-managed key."
  value       = aws_kms_key.archive.arn
}

output "books_monthly_role_arn" {
  description = "books-monthly, for the books repository's `books` environment (aws-actions/configure-aws-credentials role-to-assume)."
  value       = aws_iam_role.books.arn
}

output "console_writer_user_name" {
  description = "The IAM user to mint the console's key for (ops/mint-console-writer-key.sh)."
  value       = aws_iam_user.writer.name
}

output "connectors_secret_name" {
  description = "The Secrets Manager secret the books connectors' credentials go into (README \"Fill the connectors secret\")."
  value       = aws_secretsmanager_secret.connectors.name
}

output "console_env" {
  description = "The non-secret values the console's archive export (books lane B2) needs. BOOKS_ARCHIVE_ACCESS_KEY_ID / BOOKS_ARCHIVE_SECRET_ACCESS_KEY come from ops/mint-console-writer-key.sh, never from here."
  value = {
    BOOKS_ARCHIVE_S3_ENDPOINT    = local.s3_endpoint
    BOOKS_ARCHIVE_S3_REGION      = var.region
    BOOKS_ARCHIVE_S3_BUCKET      = aws_s3_bucket.archive.bucket
    BOOKS_ARCHIVE_S3_PREFIX      = local.console_inbound_prefix
    BOOKS_ARCHIVE_SSE_KMS_KEY_ID = aws_kms_key.archive.arn
  }
}
