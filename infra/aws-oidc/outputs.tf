# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "cp_deployer_role_arn" {
  description = "Set as the repo Actions variable CP_HETZNER_DEPLOYER_ROLE_ARN (used by infra-cp-hetzner + infra-status)."
  value       = aws_iam_role.cp_deployer.arn
}

output "runner_release_deployer_role_arn" {
  description = "Set as the repo Actions variable RUNNER_RELEASE_DEPLOYER_ROLE_ARN (used by release-runner + deploy-fleet-aws)."
  value       = aws_iam_role.runner_release_deployer.arn
}

output "deploy_reader_role_arn" {
  description = "Set as the repo Actions variable DEPLOY_READER_ROLE_ARN (used by deploy-console)."
  value       = aws_iam_role.deploy_reader.arn
}

output "connector_platform_deployer_role_arn" {
  description = "Set as the repo Actions variable CONNECTOR_PLATFORM_DEPLOYER_ROLE_ARN (used by infra-connector-platform)."
  value       = aws_iam_role.connector_platform_deployer.arn
}

output "prod_env_secret_arn" {
  description = "ARN of the alethia/prod/env Secrets Manager secret."
  value       = aws_secretsmanager_secret.prod_env.arn
}

output "oidc_provider_arn" {
  description = "Adopted GitHub Actions OIDC provider ARN."
  value       = local.oidc_provider_arn
}
