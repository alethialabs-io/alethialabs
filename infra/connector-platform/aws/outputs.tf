# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "assumer_user_name" {
  description = "The platform IAM user name (create its access key manually — see next_steps)."
  value       = aws_iam_user.assumer.name
}

output "assumer_user_arn" {
  description = "ARN of the platform assumer user."
  value       = aws_iam_user.assumer.arn
}

output "policy_arn" {
  description = "ARN of the attached least-privilege AssumeRole policy."
  value       = aws_iam_policy.assume_customer_roles.arn
}

output "next_steps" {
  description = "How to finish wiring the platform AWS identity into the console."
  value       = <<-EOT
    1) Create the access key (NOT stored in state):
         aws iam create-access-key --user-name ${aws_iam_user.assumer.name}
    2) Put it in deploy/prod/secrets.local.env:
         ALETHIA_AWS_ACCESS_KEY_ID=<AccessKeyId>
         ALETHIA_AWS_SECRET_ACCESS_KEY=<SecretAccessKey>
         # ALETHIA_AWS_ACCOUNT_ID defaults to ${var.platform_account_id}
    3) ./scripts/bootstrap-secrets.sh   &&   gh workflow run deploy-console.yml
    This lights up the AWS **and GCP** connectors (GCP federates through this same identity).
    Rotate by creating a new key, updating the vault + redeploying, then deleting the old key.
  EOT
}
