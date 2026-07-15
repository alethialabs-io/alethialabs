data "azurerm_client_config" "current" {}

# Network-ACL default-deny (AVD-AZU-0013) is suppressed in infra/.trivyignore: the external
# (Hetzner) runner needs data-plane write access at provision time, so access restriction is
# left customer-configurable per environment rather than default-on.
resource "azurerm_key_vault" "this" {
  name                       = "${var.project_name}-${var.environment}-kv"
  location                   = var.location
  resource_group_name        = var.resource_group_name
  tenant_id                  = var.tenant_id
  sku_name                   = "standard"
  purge_protection_enabled   = true
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
