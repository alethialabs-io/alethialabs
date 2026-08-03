resource "azurerm_container_registry" "this" {
  # Derived at the template root (checks_naming.tf, local.azure_acr_name) against ACR's 5-50
  # character cap. The root derivation strips every non-alphanumeric, not just hyphens.
  name                = var.registry_name
  resource_group_name = var.resource_group_name
  location            = var.location
  sku                 = var.sku
  admin_enabled       = false

  tags = var.tags
}
