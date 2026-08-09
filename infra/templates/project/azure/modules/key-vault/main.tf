data "azurerm_client_config" "current" {}

# Network-ACL default-deny (AVD-AZU-0013) is suppressed in infra/.trivyignore: the external
# (Hetzner) runner needs data-plane write access at provision time, so access restriction is
# left customer-configurable per environment rather than default-on.
resource "azurerm_key_vault" "this" {
  # Derived at the template root (checks_naming.tf, local.azure_key_vault_name), not here: Key Vault
  # caps names at 24 characters and the readable composition has no budget, so the caller resolves
  # the overflow. See #1873.
  name                = var.vault_name
  location            = var.location
  resource_group_name = var.resource_group_name
  tenant_id           = var.tenant_id
  sku_name            = "standard"

  # PURGE PROTECTION IS A ONE-WAY DOOR, AND THAT IS THE WHOLE PROBLEM WITH IT.
  #
  # Azure's own words: "Once Purge Protection has been Enabled it's not possible to Disable it"
  # (hashicorp/azurerm azurerm_key_vault docs), and with it on "a vault or an object in the deleted
  # state can't be purged until the retention period passes"
  # (learn.microsoft.com/azure/key-vault/general/soft-delete-overview).
  #
  # What that costs, concretely. Deleting the resource group SOFT-deletes this vault; the vault's
  # name is then reserved for the full retention window and CANNOT be released, because purging is
  # exactly what purge protection forbids. So a customer who destroys an environment and rebuilds
  # the same project + environment inside the window is refused — the vault name is derived from
  # `<project_name>-<environment>` (checks_naming.tf) and is therefore the same name again — and
  # there is no console path out of it. That is the same shape as the DynamoDB deletion-protection
  # trap: a protective default with no control to turn it off.
  #
  # WHY THE DEFAULT IS STILL `true`. Flipping it is not a free fix. Because the setting cannot be
  # disabled, changing the default to `false` makes the very next `tofu apply` on every EXISTING
  # environment fail — the provider rejects the true → false transition outright. Turning it into a
  # variable that DEFAULTS to today's value is bit-identical for everything already deployed (no
  # plan diff anywhere) while making the setting reachable: `mergeProviderConfig` passthrough means
  # a declared root variable is settable per project, so a new environment can be created without
  # the trap and an e2e-shaped deployment can turn it off outright.
  #
  # The retention window is already the 7-day minimum Azure permits (the range is 7-90, default 90),
  # and it too "can only be configured one time and cannot be updated" — so it is set as low as it
  # can be for the case where a vault does end up soft-deleted.
  purge_protection_enabled   = var.purge_protection_enabled
  soft_delete_retention_days = 7
  rbac_authorization_enabled = true

  tags = var.tags
}

locals {
  generated_secrets = {
    for s in var.secrets : s.name => s if s.generate
  }

  all_secrets = {
    for s in var.secrets : s.name => s
  }
}

resource "random_password" "this" {
  for_each = local.generated_secrets

  length  = each.value.length
  special = each.value.special_chars

  # Rotation handle (parity with aws/modules/awssm-passgen and gcp/modules/secret-manager).
  # `{}` for a secret with no entry — identical to the previous, keeper-less resource, so an
  # existing vault plans unchanged.
  keepers = lookup(var.secret_keepers, each.key, {})
}

# The vault is created with rbac_authorization_enabled = true, but NOTHING granted the identity
# running the apply any data-plane role — so writing the project's secrets failed every time:
#   403 Forbidden / ForbiddenByRbac — Action 'Microsoft.KeyVault/vaults/secrets/setSecret/action'
#   ... Assignment: (not found)
# i.e. the SECRETS KIND could never be created. Vault RBAC is data-plane: being subscription Owner
# is NOT sufficient. Grant the provisioner "Key Vault Secrets Officer" on the vault scope.
resource "azurerm_role_assignment" "provisioner_secrets_officer" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_key_vault_secret" "this" {
  for_each = local.all_secrets

  name         = each.key
  value        = each.value.generate ? random_password.this[each.key].result : ""
  key_vault_id = azurerm_key_vault.this.id

  # RBAC propagation is eventually-consistent; without the explicit edge the secret write races the
  # role assignment and 403s.
  depends_on = [azurerm_role_assignment.provisioner_secrets_officer]

  tags = var.tags
}
