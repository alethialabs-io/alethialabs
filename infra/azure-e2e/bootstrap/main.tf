# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Bootstrap for infra/azure-e2e: the storage account + container that hold its OpenTofu state.
#
# THIS IS THE FILE `backend_override.tf` WAS WAITING FOR. That untracked, self-labelled TEMPORARY
# override forces `backend "local" {}` because — in its own words — "the azurerm backend needs a
# storage account that this stack has not created yet (chicken/egg)". This stack creates it. Apply
# this first and the parent stack inits straight onto the real backend, with no override to write
# and none to forget to delete.
#
# infra/azure-e2e owns an Entra application, its service principal, the GitHub federated credential,
# three subscription role assignments and the AKS admin group whose object id authorizes the runner
# as cluster-admin. Rebuilding those by hand from an empty state means re-issuing a client id that
# is already published as a repo variable — so this state is worth a storage account.
#
# This stack's OWN state goes into the container it creates, via one documented two-phase init
# (`-backend=false` → apply → `-migrate-state`). Runbook: docs/testing/e2e-state-migration.md.

locals {
  tags = {
    project = "alethia"
    role    = "azure-e2e-bootstrap"
    managed = "opentofu"
  }
}

resource "azurerm_resource_group" "tfstate" {
  name     = var.state_resource_group_name
  location = var.location
  tags     = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

# The network default action is `Allow` until `state_network_allowed_cidrs` is set, which Trivy
# reports as AVD-AZU-0012. Accepted, and scoped to THIS resource with an inline ignore rather than a
# repo-wide entry in infra/.trivyignore — that id must keep firing on the customer-facing Azure
# templates. The reasoning is on the variable: this account is reached only from a maintainer's
# laptop on a changing address, and its wall is that no shared key exists to steal — every request
# carries an Entra identity holding Storage Blob Data Contributor.
#trivy:ignore:AVD-AZU-0012
resource "azurerm_storage_account" "tfstate" {
  name                     = var.state_storage_account_name
  resource_group_name      = azurerm_resource_group.tfstate.name
  location                 = azurerm_resource_group.tfstate.location
  account_kind             = "StorageV2"
  account_tier             = "Standard"
  account_replication_type = "GRS"

  # Keyless, to the same standard the rest of this repo holds itself to. With shared keys disabled
  # there is no account key in existence to leak, and the only way in is an Entra role assignment
  # (see azurerm_role_assignment.state_writers). The backend reaches it with `use_azuread_auth`.
  shared_access_key_enabled = false

  https_traffic_only_enabled      = true
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false

  # Network ACL. Off by default and on the moment `state_network_allowed_cidrs` is non-empty — see
  # that variable for why a default-Deny is the wrong default for an account only a maintainer's
  # laptop ever reaches.
  network_rules {
    default_action = length(var.state_network_allowed_cidrs) > 0 ? "Deny" : "Allow"
    ip_rules       = var.state_network_allowed_cidrs
    bypass         = ["AzureServices"]
  }

  blob_properties {
    # Versioning is the durability property that matters: each apply writes a new blob version, so
    # a truncated write or an accidental delete is recoverable to the previous one.
    versioning_enabled = true

    delete_retention_policy {
      days = var.state_retention_days
    }

    container_delete_retention_policy {
      days = var.state_retention_days
    }
  }

  tags = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

# Addressed by `storage_account_id` rather than the legacy `storage_account_name`: that is what
# makes the provider manage the container through the Resource Manager API instead of the blob data
# plane. The data-plane path needs a shared key, which this account does not have.
resource "azurerm_storage_container" "tfstate" {
  name                  = var.state_container_name
  storage_account_id    = azurerm_storage_account.tfstate.id
  container_access_type = "private"
}

# Without at least one of these, nobody can read or write the state — see the variable's docstring.
resource "azurerm_role_assignment" "state_writers" {
  for_each = toset(var.state_writer_principal_ids)

  scope                = azurerm_storage_account.tfstate.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = each.value
}

# A stack that nobody can write state for is worse than one with local state, because the failure
# looks like a backend bug. Say it out loud at plan time instead.
check "state_has_at_least_one_writer" {
  assert {
    condition     = length(var.state_writer_principal_ids) > 0
    error_message = "state_writer_principal_ids is empty: the state account has shared-key auth disabled, so with no Storage Blob Data Contributor assignment every `tofu init` against this backend will 403. Add the maintainer's object id (`az ad signed-in-user show --query id -o tsv`)."
  }
}
