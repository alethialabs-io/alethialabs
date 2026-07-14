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
