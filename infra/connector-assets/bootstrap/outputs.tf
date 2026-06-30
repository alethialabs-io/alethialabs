# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "deployer_role_arn" {
  description = "Set as the repo Actions variable CONNECTOR_ASSETS_DEPLOYER_ROLE_ARN; assume it for local apply."
  value       = aws_iam_role.deployer.arn
}

output "oidc_provider_arn" {
  description = "GitHub Actions OIDC provider ARN (created or adopted)."
  value       = local.oidc_provider_arn
}
