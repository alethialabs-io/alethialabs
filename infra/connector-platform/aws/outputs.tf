# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "assumer_role_name" {
  description = "The platform IAM role the console federates into (keyless — no access key to create)."
  value       = aws_iam_role.assumer.name
}

output "assumer_role_arn" {
  description = "ARN of the platform assumer role — set as ALETHIA_AWS_PLATFORM_ROLE_ARN."
  value       = aws_iam_role.assumer.arn
}

output "oidc_provider_arn" {
  description = "ARN of the Alethia OIDC identity provider."
  value       = aws_iam_openid_connect_provider.alethia.arn
}

output "policy_arn" {
  description = "ARN of the attached least-privilege AssumeRole policy."
  value       = aws_iam_policy.assume_customer_roles.arn
}

output "next_steps" {
  description = "How to finish wiring the keyless platform AWS identity into the console."
  value       = <<-EOT
    No access key to create — the console federates in via the OIDC issuer.
    1) Put the role ARN in deploy/prod/secrets.local.env:
         ALETHIA_AWS_PLATFORM_ROLE_ARN=${aws_iam_role.assumer.arn}
         # ALETHIA_AWS_ACCOUNT_ID defaults to ${var.platform_account_id}
    2) ./scripts/bootstrap-secrets.sh   &&   gh workflow run deploy-console.yml
    This lights up the AWS **and GCP** connectors (GCP federates through this same identity).
    Rotation is automatic — the console mints a fresh assertion per ~1h session; nothing to rotate.
  EOT
}
