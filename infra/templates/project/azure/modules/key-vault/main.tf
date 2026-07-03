data "azurerm_client_config" "current" {}

# trivy:ignore:AVD-AZU-0013 Network-ACL default-deny would block the external (Hetzner)
# runner's data-plane writes during provisioning; access restriction is left customer-
# configurable per environment.
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

resource "azurerm_key_vault_secret" "this" {
  for_each = local.all_secrets

  name         = each.key
  value        = each.value.generate ? random_password.this[each.key].result : ""
  key_vault_id = azurerm_key_vault.this.id

  tags = var.tags
}
