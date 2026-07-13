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

output "prod_env_secret_arn" {
  description = "ARN of the alethia/prod/env Secrets Manager secret."
  value       = aws_secretsmanager_secret.prod_env.arn
}

output "oidc_provider_arn" {
  description = "Adopted GitHub Actions OIDC provider ARN."
  value       = local.oidc_provider_arn
}

# ── BYOC A1.1 e2e-nightly ─────────────────────────────────────────────────────
output "e2e_nightly_role_arn" {
  description = "Set as the repo Actions VARIABLE E2E_AWS_ROLE_ARN to enable the AWS T2 nightly (e2e-nightly.yml gates on it)."
  value       = aws_iam_role.e2e_nightly.arn
}

output "e2e_boundary_policy_arn" {
  description = "ARN of the permissions boundary capping the e2e-nightly role."
  value       = aws_iam_policy.e2e_boundary.arn
}

output "e2e_budget_sns_topic_arn" {
  description = "SNS topic the e2e AWS Budget alerts publish to (hang a kill-switch here later)."
  value       = aws_sns_topic.e2e_budget.arn
}
