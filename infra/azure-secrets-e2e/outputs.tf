# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Exactly the repo VARIABLES the nightly's azure leg reads (README.md maps each one). None is a
# secret: a subscription id, a URL, names and a digest. The canary VALUE never appears here.
#
# The _AZURE suffix matters. ACCOUNT, REMOTE_KEY and EXPECT_SHA256 are shared with the aws and gcp
# legs, and the harness resolves "<base>_AZURE" before the flat variable (t2ArgoEnvForProvider). So
# the azure values go in the per-cloud siblings and cannot clobber another cloud's.

output "target_subscription_id" {
  description = "E2E_SECRETS_XACCT_ACCOUNT_AZURE — the subscription the connector reads from (provider_config.target_subscription_id)."
  value       = data.azurerm_subscription.target.subscription_id
}

output "vault_url" {
  description = "E2E_SECRETS_XACCT_VAULT_URL — the account-B vault (provider_config.vault_url)."
  value       = azurerm_key_vault.xacct.vault_uri
}

output "remote_key" {
  description = "E2E_SECRETS_XACCT_REMOTE_KEY_AZURE — the canary secret's name in the vault."
  value       = azurerm_key_vault_secret.canary.name
}

output "expect_sha256" {
  description = "E2E_SECRETS_XACCT_EXPECT_SHA256_AZURE — sha256 of the canary value, which the in-cluster read is compared against."
  # nonsensitive() is the design, as in the aws and gcp siblings. The digest inherits canary_value's
  # sensitive mark, but a sha256 of a high-entropy value is what lets the expectation travel to CI
  # while the value never leaves this stack.
  value = nonsensitive(sha256(var.canary_value))
}

output "eso_identity_name" {
  description = "E2E_SECRETS_XACCT_ESO_IDENTITY_NAME — the standing identity the cluster adopts (external_secrets_identity_name)."
  value       = azurerm_user_assigned_identity.eso.name
}

output "eso_identity_resource_group" {
  description = "E2E_SECRETS_XACCT_ESO_IDENTITY_RG — its resource group in subscription A (external_secrets_identity_resource_group)."
  value       = azurerm_resource_group.identity.name
}
