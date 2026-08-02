# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Azure Database + Cache data-tier invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

# When an Azure Database flexible server is created, an engine must be specified.
check "azure_db_engine_present_when_created" {
  assert {
    condition     = !var.create_azure_db || length(trimspace(var.azure_db_engine)) > 0
    error_message = "create_azure_db is true but azure_db_engine is empty; set postgres or mysql."
  }
}

# Keyless Postgres auth (#722 R5): when Entra auth is on, the app must have a federated
# Workload-Identity path to the DB AND a dedicated admin must own the Entra-administrator role — the
# app identity must NOT be admin (least-privilege). Assert both UAMIs + both federated credentials
# exist and the SOLE Entra administrator is db_admin, so a keyless binding can't render pointed at an
# identity that can never log in, and the app can never be a DB superuser. Requires AKS (the OIDC
# issuer the credentials federate through) and postgres.
check "keyless_azure_db_app_identity_wired" {
  assert {
    condition = !(var.create_azure_db && var.azure_db_iam_auth && var.azure_db_engine == "postgres") || (
      var.provision_aks &&
      length(azurerm_user_assigned_identity.app_db) == 1 &&
      length(azurerm_federated_identity_credential.app_db) == 1 &&
      length(azurerm_user_assigned_identity.db_admin) == 1 &&
      length(azurerm_federated_identity_credential.db_admin) == 1 &&
      length(azurerm_postgresql_flexible_server_active_directory_administrator.db_admin) == 1
    )
    error_message = "azure_db_iam_auth is on for postgres but the keyless identities are incomplete: it needs provision_aks=true, the app UAMI + its federated credential, and a DEDICATED db_admin UAMI + its federated credential registered as the sole Entra administrator (the app must not be admin)."
  }
}

# Zone redundancy for Azure Cache for Redis requires the Premium SKU.
check "azure_cache_multi_az_requires_premium" {
  assert {
    condition     = !var.create_azure_cache || !var.azure_cache_multi_az || var.azure_cache_sku == "Premium"
    error_message = "azure_cache_multi_az (zone redundancy) requires azure_cache_sku = \"Premium\"."
  }
}

# BYOC B4.1 — every DB allow-listed CIDR must be a valid IPv4 CIDR (each expands to a
# start/end firewall IP range), so a malformed entry fails at plan time.
check "azure_db_allowed_cidrs_valid_cidrs" {
  assert {
    condition = alltrue([
      for c in var.azure_db_allowed_cidrs : can(cidrhost(c, 0))
    ])
    error_message = "azure_db_allowed_cidrs entries must be valid IPv4 CIDRs (e.g. 203.0.113.10/32)."
  }
}
