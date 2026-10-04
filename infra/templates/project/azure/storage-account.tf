module "storage_account" {
  source = "./modules/storage-account"
  count  = var.create_storage_account ? 1 : 0

  # A HARD dependency, as in aks.tf: the account is created already encrypted under the key, AS the
  # identity, so the identity's grant on the key must exist first. A no-op when CMEK is off (the
  # role assignment then has count 0).
  depends_on = [azurerm_role_assignment.storage_cmek]

  location            = var.location
  environment         = var.environment
  project_name        = var.project_name
  resource_group_name = azurerm_resource_group.main.name
  account_name        = local.azure_storage_account_name
  account_tier        = var.storage_account_tier
  replication_type    = var.storage_account_replication
  containers          = var.storage_containers

  # Customer-managed key (below). Empty strings when no container asked for it, which render
  # neither the identity nor the customer_managed_key block — the account plans as it always did.
  cmek_key_id      = local.storage_cmek ? one(azurerm_key_vault_key.storage_cmek[*].versionless_id) : ""
  cmek_identity_id = local.storage_cmek ? one(azurerm_user_assigned_identity.storage_cmek[*].id) : ""

  tags = local.azure_default_tags
}

################################################################################
# Customer-managed key (storage_containers[*].cmek_enabled) — CUSTOMIZABILITY-PARITY top gap #8
################################################################################
# Encryption is a property of the storage ACCOUNT and a project has one, so any container asking for
# CMEK encrypts the account — the same anytrue aggregation versioning uses, for the same reason: the
# wider answer costs a key, the narrower one silently ignores a user who asked for their own key.
#
# The key lives in this project's own Key Vault (modules/key-vault). What is created, and why each
# piece is the narrowest that works:
#   · a user-assigned identity — the account unwraps AS it, and it has to exist (and be granted)
#     before the account does, which a system-assigned identity cannot;
#   · "Key Vault Crypto Service Encryption User" for that identity, scoped to THE KEY, not the
#     vault: exactly keys/read + wrapKey + unwrapKey (get/wrap/unwrap), and on nothing else;
#   · the provisioner's "Key Vault Crypto Officer" on the vault, to create the key. Shared with the
#     AKS KMS key in secrets-encryption.tf rather than declared twice: Azure refuses a second,
#     identical role assignment with 409 RoleAssignmentExists.
#
# Default (no container asks): none of this exists and the account keeps Microsoft-managed keys.

locals {
  storage_cmek = var.create_storage_account && anytrue([for c in var.storage_containers : c.cmek_enabled])
}

# Azure Storage refuses a key from a vault without purge protection — a purged key would make every
# blob in the account permanently unreadable. Fail at PLAN naming the variable, not at apply naming
# neither (the same guard secrets-encryption.tf puts in front of the AKS KMS key).
resource "terraform_data" "storage_cmek_purge_protection_guard" {
  count = local.storage_cmek ? 1 : 0

  lifecycle {
    precondition {
      condition     = var.key_vault_purge_protection_enabled
      error_message = "cmek_enabled on a storage container requires key_vault_purge_protection_enabled = true: Azure Storage refuses a customer-managed key from a vault whose keys could be purged, because purging it would leave every blob in the account permanently unreadable."
    }
  }
}

resource "azurerm_user_assigned_identity" "storage_cmek" {
  count = local.storage_cmek ? 1 : 0

  name                = "${local.azure_storage_account_name}-cmek"
  location            = var.location
  resource_group_name = azurerm_resource_group.main.name

  tags = local.azure_default_tags
}

resource "azurerm_key_vault_key" "storage_cmek" {
  count = local.storage_cmek ? 1 : 0

  # RBAC propagation is eventually consistent; the explicit edge keeps key creation behind the
  # provisioner's Crypto Officer grant (see secrets-encryption.tf for the 403 that taught this).
  depends_on = [
    terraform_data.storage_cmek_purge_protection_guard,
    azurerm_role_assignment.provisioner_crypto_officer,
  ]

  name         = "storage-cmek"
  key_vault_id = module.key_vault.vault_id
  key_type     = "RSA"
  key_size     = 2048

  # Wrap/unwrap only: Azure Storage uses the key to wrap its account encryption key and never to
  # encrypt data directly, so the key cannot be used for anything else either.
  key_opts = ["unwrapKey", "wrapKey"]

  # Tagged for the sweeper: purge protection means an orphaned key cannot be purged.
  tags = local.azure_default_tags
}

# Scoped to the KEY. `resource_versionless_id` is the key's ARM id (…/vaults/<v>/keys/<k>), which
# is a valid role-assignment scope; the vault-scoped AKS grant in secrets-encryption.tf is wider only
# because its test could not supply this id — this one's test mocks it.
resource "azurerm_role_assignment" "storage_cmek" {
  count = local.storage_cmek ? 1 : 0

  scope                = one(azurerm_key_vault_key.storage_cmek[*].resource_versionless_id)
  role_definition_name = "Key Vault Crypto Service Encryption User"
  principal_id         = one(azurerm_user_assigned_identity.storage_cmek[*].principal_id)
}
