# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Two of these become repo VARIABLES at the cutover (README step 6). Neither is a secret.

output "e2e_nightly_role_arn" {
  description = "The NEW value of the repo variable E2E_AWS_ROLE_ARN. Flipping it moves every AWS e2e workflow (e2e-nightly, e2e-orphan-reaper, catalog-drift, byo-users-managed-mysql) into this account."
  value       = aws_iam_role.e2e_nightly.arn
}

output "e2e_dns_zone_id" {
  description = "The NEW value of the repo variable E2E_ACM_CERT_ZONE_ID. Flip it together with E2E_AWS_ROLE_ARN: the new role cannot write the old zone, and the old role cannot write this one."
  value       = aws_route53_zone.e2e.zone_id
}

output "e2e_dns_zone_name_servers" {
  description = "Paste these four into Cloudflare as the NS record set for the e2e zone name (README step 5). Verify with: dig +short NS <zone> @1.1.1.1"
  value       = aws_route53_zone.e2e.name_servers
}

output "github_oidc_provider_arn" {
  description = "The GitHub Actions OIDC provider created in the e2e account."
  value       = aws_iam_openid_connect_provider.github.arn
}

output "e2e_boundary_policy_arn" {
  description = "The permissions boundary capping the e2e-nightly role."
  value       = aws_iam_policy.e2e_boundary.arn
}

output "e2e_budget_sns_topic_arn" {
  description = "SNS topic the e2e account Budget publishes to."
  value       = aws_sns_topic.e2e_budget.arn
}

output "e2e_broker_oidc_provider_arn" {
  description = "The IAM OIDC provider trusting the E2E assertion broker, or null while e2e_broker_issuer_url is unset."
  value       = one(aws_iam_openid_connect_provider.e2e_broker[*].arn)
}

output "e2e_account_id" {
  description = "The account the provider actually operated in, read back from STS (not echoed from the variable)."
  value       = data.aws_caller_identity.current.account_id
}
