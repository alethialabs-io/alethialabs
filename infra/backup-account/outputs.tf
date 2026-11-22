# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# None of these is a secret. The writer's access key pair is minted outside this stack (README step
# 6) and is never an output.

output "backup_account_id" {
  description = "The account the provider actually operated in, read back from STS (not echoed from the variable)."
  value       = data.aws_caller_identity.current.account_id
}

output "bucket_name" {
  description = "The Object-Lock bucket → BACKUP_S3_BUCKET."
  value       = aws_s3_bucket.backup.bucket
}

output "kms_key_arn" {
  description = "The bucket's customer-managed key."
  value       = aws_kms_key.backup.arn
}

output "writer_user_name" {
  description = "The IAM user to mint the box's key for (ops/03-mint-writer-key.sh)."
  value       = aws_iam_user.writer.name
}

output "reader_role_arn" {
  description = "backup-reader, for backup-status.yml (BKP-L2)."
  value       = aws_iam_role.reader.arn
}

output "drill_launcher_role_arn" {
  description = "drill-launcher, for restore-drill.yml (BKP-L3)."
  value       = aws_iam_role.launcher.arn
}

output "drill_launch_template_id" {
  description = "The one launch template drill-launcher may run."
  value       = aws_launch_template.drill.id
}

output "drill_identity_secret_name" {
  description = "The Secrets Manager secret the drill's age identity goes into (README step 5)."
  value       = aws_secretsmanager_secret.drill_identity.name
}

output "backup_env" {
  description = "The non-secret /etc/alethia/backup.env values (BKP-L1). BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY come from ops/03-mint-writer-key.sh, never from here."
  value = {
    BACKUP_S3_PROVIDER = "AWS"
    BACKUP_S3_ENDPOINT = local.s3_endpoint
    BACKUP_S3_REGION   = var.backup_region
    BACKUP_S3_BUCKET   = aws_s3_bucket.backup.bucket
    BACKUP_PREFIX      = var.backup_prefix
    # backup.sh's bucket mode (BKP-L1) asks S3 for SSE-KMS under this key explicitly.
    BACKUP_S3_SSE_KMS_KEY_ID = aws_kms_key.backup.arn
  }
}
