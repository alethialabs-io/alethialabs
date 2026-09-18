# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "E2E_ALIBABA_ROLE_ARN" {
  description = "Set as the repo Actions VARIABLE E2E_ALIBABA_ROLE_ARN to enable the Alibaba T2 nightly (e2e-nightly.yml gates on it)."
  value       = alicloud_ram_role.e2e.arn
}

output "E2E_ALIBABA_OIDC_PROVIDER_ARN" {
  description = "Set as the repo Actions VARIABLE E2E_ALIBABA_OIDC_PROVIDER_ARN (the RAM OIDC provider the nightly's token is exchanged against)."
  value       = alicloud_ims_oidc_provider.github.arn
}

output "account_id" {
  description = "The Alibaba account id this bootstrap was applied in (informational)."
  value       = data.alicloud_caller_identity.current.account_id
}

# ── E2E assertion broker trust (#4226) ────────────────────────────────────────
output "e2e_broker_oidc_provider_arn" {
  description = "The RAM OIDC provider trusting the E2E assertion broker, or null while e2e_broker_issuer_url is unset. AssumeRoleWithOIDC names this as OIDCProviderArn and E2E_ALIBABA_ROLE_ARN as RoleArn."
  value       = one(alicloud_ims_oidc_provider.e2e_broker[*].arn)
}
