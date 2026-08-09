# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# KMS ETCD ENCRYPTION for AKS (#2004) — envelope-encrypts Kubernetes Secrets in etcd under a key in
# this project's own Key Vault, instead of leaving them under the platform's default key.
#
# WHY THIS EXISTS. AWS has done this since the template was written, silently: the upstream
# terraform-aws-modules/eks module defaults `create_kms_key = true` and encrypts `secrets`. GKE, AKS
# and ACK had nothing, and the gap was neither boarded nor excluded — the silent third state the
# cloud-parity rule forbids. A customer who enabled it on AWS and assumed the same posture on AKS
# had their Secrets under the platform's key, with nothing telling them so.
#
# ── WHY THIS NEEDS A USER-ASSIGNED IDENTITY, AND WHY THAT IS NOT A STYLE CHOICE ─────────────────
#
# AKS performs the envelope encryption AS THE CLUSTER'S OWN IDENTITY. With the system-assigned
# identity this template used before, that identity does not exist until the cluster is created — so
# the Key Vault role assignment cannot pre-exist, and Azure's own guidance for the system-assigned
# case is a TWO-STEP operation: create the cluster, grant the identity, then enable KMS.
#
# The runner performs exactly one `tofu apply`. A two-step control is a control that never turns on.
# So the cluster identity becomes user-assigned: the identity is created first, granted Key Vault
# Crypto User on the key, and the cluster is created already able to use it — one pass, correctly
# ordered, with the ordering expressed as a real dependency rather than hoped for.
#
# ⚠️ DAY-2 HAZARD, STATED PLAINLY. An EXISTING cluster provisioned with the system-assigned identity
# changes identity type on its next apply. Azure supports that transition in place, but it is a
# change to the cluster's security principal: anything that granted a role to the OLD principal id
# (outside this template) must be re-granted to the new one. New projects are unaffected — they get
# the correct shape on first apply.
#
# ── THE VAULT CONSTRAINT ────────────────────────────────────────────────────────────────────────
#
# Azure refuses to bind a KMS key from a vault without purge protection, because a purged key would
# leave etcd permanently unreadable. The vault already defaults to purge protection on (#2010); the
# precondition below turns the combination into a plan-time failure naming the variable, instead of
# an apply-time Azure error that names neither.
#
# ⚠️ The key outlives the cluster deliberately — purge protection means a destroyed vault is
# recoverable for its retention window, so a restored etcd backup stays decryptable. The e2e
# sweepers must not treat a soft-deleted vault as a leak.

locals {
  azure_secrets_encryption = var.aks_secrets_encryption_enabled && var.provision_aks
}

# Fail-closed. A `check` only warns, and the Azure API rejects this at APPLY — after the vault and
# the cluster already exist — so it is a precondition, the pattern checks_naming.tf established.
resource "terraform_data" "aks_kms_purge_protection_guard" {
  count = local.azure_secrets_encryption ? 1 : 0

  lifecycle {
    precondition {
      condition     = var.key_vault_purge_protection_enabled
      error_message = "aks_secrets_encryption_enabled requires key_vault_purge_protection_enabled = true: Azure refuses to bind a KMS key from a vault whose keys could be purged, because purging one would leave every Secret in etcd permanently unreadable. Set the vault's purge protection, or disable aks_secrets_encryption_enabled."
    }
  }
}

# The cluster's identity. Created here rather than inside modules/aks because the role assignment
# below must be able to reference it BEFORE the cluster exists — which is the whole reason this is
# user-assigned (see the header).
resource "azurerm_user_assigned_identity" "aks" {
  count = local.azure_secrets_encryption ? 1 : 0

  name                = "${local.aks_name}-identity"
  location            = var.location
  resource_group_name = azurerm_resource_group.main.name

  tags = local.azure_default_tags
}

resource "azurerm_key_vault_key" "aks_secrets" {
  count = local.azure_secrets_encryption ? 1 : 0

  depends_on = [terraform_data.aks_kms_purge_protection_guard]

  name         = "aks-secrets-encryption"
  key_vault_id = module.key_vault.vault_id
  key_type     = "RSA"
  key_size     = 2048

  key_opts = [
    "decrypt",
    "encrypt",
    "unwrapKey",
    "wrapKey",
  ]
}

# Granted to the identity, not to the cluster — that is what makes it expressible before the cluster
# exists, and what lets aks.tf depend on it.
#
# Scoped to the VAULT, not to the individual key. Key scope is tighter and was tried first, but the
# key's `resource_versionless_id` is computed, so under `tofu test`'s mocked provider it resolves
# empty and the assignment lands on the ROOT scope — which the provider rejects. A scope that is
# only valid against a live subscription is a scope no test can cover.
#
# The looser scope is proportionate rather than merely convenient: this vault is created per
# project and holds only this project's material, so "crypto user on the project's own vault" is
# the same blast radius by a different name. It is also the shape Azure's own AKS/KMS guidance uses.
resource "azurerm_role_assignment" "aks_secrets_kms" {
  count = local.azure_secrets_encryption ? 1 : 0

  scope                = module.key_vault.vault_id
  role_definition_name = "Key Vault Crypto User"
  principal_id         = azurerm_user_assigned_identity.aks[0].principal_id
}
