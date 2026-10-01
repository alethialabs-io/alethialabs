# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Subscription B for the cross-SUBSCRIPTION keyless Key Vault e2e (#1268), the Azure sibling of
# infra/aws-secrets-e2e and infra/gcp-secrets-e2e.
#
# The e2e provisions an AKS cluster in subscription A and proves the in-cluster External Secrets
# Operator reads a secret from a Key Vault HERE, in subscription B (same tenant), with no credential
# anywhere: ESO authenticates with the cluster's workload identity (authType: WorkloadIdentity) and
# reads the vault by URL. This stack is the customer's side of Model B, applied ONCE by hand.
#
# ── HOW THE PRINCIPAL AND THE ISSUER ARE PASSED ─────────────────────────────────────────────────
#
# An Azure role assignment names a principal's OBJECT ID. A per-run managed identity gets a new one on
# every create, so a grant written against it is dead by the next run. The azure project template
# therefore lets a cluster ADOPT a standing user-assigned identity (external_secrets_identity_name +
# _resource_group, reachable through the cluster's provider_config passthrough).
#
# So this stack creates that STANDING identity in subscription A and grants ITS principal id here, in
# subscription B. The principal therefore never has to be passed in by hand: it is read straight
# off the resource this stack owns, and a recreate of the identity re-points the grant in the same
# apply.
#
# The ISSUER is not an input here at all, and must not be. Each run's AKS cluster has its own OIDC
# issuer URL. The project template writes a federated credential on the adopted identity for that
# issuer and the ESO service account, named after the cluster, and `tofu destroy` removes it again
# (infra/templates/project/azure/workload-identity.tf). Subscription B trusts the IDENTITY. Which
# cluster may act as it is subscription A's per-run business.
#
# ⚠️ Known limit: Azure caps federated credentials at 20 per identity. A run hard-killed before its
# destroy leaves its credential behind, because the RG sweep (scripts/e2e/azure-cleanup.sh) deletes
# per-run resource groups and this identity lives in none of them. Twenty leaked credentials make
# the next adopt fail at apply. List them with `az identity federated-credential list` and delete the
# stale ones.

data "azurerm_client_config" "current" {}

data "azurerm_subscription" "target" {}

data "azurerm_subscription" "cluster" {
  provider = azurerm.cluster
}

# ── subscription A: the standing identity ─────────────────────────────────────────────────────

resource "azurerm_resource_group" "identity" {
  provider = azurerm.cluster
  name     = var.identity_resource_group_name
  location = var.location
  tags     = var.tags
}

resource "azurerm_user_assigned_identity" "eso" {
  provider            = azurerm.cluster
  name                = var.identity_name
  resource_group_name = azurerm_resource_group.identity.name
  location            = var.location
  tags                = var.tags

  lifecycle {
    # Cross-SUBSCRIPTION is the whole claim. A read inside one subscription would pass the e2e
    # and report a boundary crossing that never happened. This fails the plan, unlike a check block,
    # which only warns.
    precondition {
      condition     = lower(var.target_subscription_id) != lower(var.cluster_subscription_id)
      error_message = "target_subscription_id equals cluster_subscription_id — a same-subscription read proves nothing about crossing a boundary."
    }
    # Workload identity cannot cross a tenant (a documented Azure limit and a documented exclusion of
    # the azure-kv-xacct connector), so a two-tenant apply builds a grant that can never be used.
    precondition {
      condition     = data.azurerm_subscription.target.tenant_id == data.azurerm_subscription.cluster.tenant_id
      error_message = "The two subscriptions are in different tenants. Keyless Key Vault access across tenants is impossible; azure-kv-xacct is same-tenant, cross-subscription only."
    }
  }
}

# ── subscription B: the vault, the canary, the grant ──────────────────────────────────────────

resource "azurerm_resource_group" "vault" {
  name     = var.vault_resource_group_name
  location = var.location
  tags     = var.tags
}

resource "random_string" "vault_suffix" {
  length  = 6
  upper   = false
  special = false
}

# Standard SKU: the cheapest tier. Premium buys HSM-backed keys, which a secret read does not use.
# The cost is per operation (a few reads a night), so the fixture costs cents a month.
resource "azurerm_key_vault" "xacct" {
  name                = "${var.vault_name_prefix}${random_string.vault_suffix.result}"
  location            = azurerm_resource_group.vault.location
  resource_group_name = azurerm_resource_group.vault.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"

  # RBAC-only: no access policies exist, so the role assignments below are the whole access model.
  rbac_authorization_enabled = true

  # A test fixture. Purge protection could never be switched off again and would hold the name for
  # the retention window after a destroy. 7 days is the minimum Azure allows.
  purge_protection_enabled   = false
  soft_delete_retention_days = 7

  # Public endpoint: the cluster in subscription A reaches it over the internet, authenticated by
  # Entra. A private endpoint would need networking into every per-run VNet.
  public_network_access_enabled = true

  tags = var.tags
}

# Vault RBAC is data-plane: being subscription Owner does not let the applier write the canary.
# Grant it Secrets Officer on this vault only (the same fix as the project template's key-vault module).
resource "azurerm_role_assignment" "applier_secrets_officer" {
  scope                = azurerm_key_vault.xacct.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_key_vault_secret" "canary" {
  name         = var.secret_name
  value        = var.canary_value
  key_vault_id = azurerm_key_vault.xacct.id
  content_type = "text/plain"
  tags         = var.tags

  # RBAC propagation is eventually consistent. Without this edge the write races the role assignment
  # and gets a 403. If it still 403s on a first apply, wait a few minutes and apply again.
  depends_on = [azurerm_role_assignment.applier_secrets_officer]
}

# The grant: the STANDING identity from subscription A, Key Vault Secrets User, on this ONE secret.
# Secret scope rather than vault scope. ESO reads the canary by name, and a long-lived identity with
# read on a whole vault would be a permanent widening, not a test fixture.
resource "azurerm_role_assignment" "eso_canary_reader" {
  scope                = azurerm_key_vault_secret.canary.resource_versionless_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.eso.principal_id
  principal_type       = "ServicePrincipal"
}
