# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# External-secrets managed-identity invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

# The external-secrets workload identity + the vault URI must exist whenever AKS is provisioned —
# without them the azurekv ClusterSecretStore is (correctly) not rendered and can never sync.
check "external_secrets_identity_present" {
  assert {
    condition     = !var.provision_aks || (length(trimspace(try(azurerm_user_assigned_identity.external_secrets[0].client_id, ""))) > 0 && startswith(module.key_vault.vault_uri, "https://"))
    error_message = "provision_aks is true but the external-secrets managed identity or Key Vault URI is missing — the ESO ClusterSecretStore cannot authenticate."
  }
}

# Adoption needs BOTH inputs (the data source is keyed on name + resource group). Supplying only one
# must fail loudly here: silently falling back to "create our own" would provision a cluster whose
# ESO identity is NOT the one the target subscription granted, and the cross-subscription read would
# fail at runtime with an authorization error far from its cause.
check "external_secrets_adoption_inputs_paired" {
  assert {
    condition     = (var.external_secrets_identity_name == "") == (var.external_secrets_identity_resource_group == "")
    error_message = "external_secrets_identity_name and external_secrets_identity_resource_group must be set together (or both left empty to have this template create the identity)."
  }
}

# The external-secrets identity must resolve to exactly one of "created here" or "adopted".
check "external_secrets_identity_resolved" {
  assert {
    condition     = !var.provision_aks || local.external_secrets_client_id != ""
    error_message = "The external-secrets managed identity resolved to an empty client id — set external_secrets_identity_name/_resource_group to adopt a pre-existing identity, or leave both empty to have this template create one."
  }
}

check "external_secrets_identity_single_owner" {
  assert {
    condition     = !var.provision_aks || (local.external_secrets_adopted != (length(azurerm_user_assigned_identity.external_secrets) > 0))
    error_message = "The external-secrets managed identity must be either adopted or created by this template, never both."
  }
}
