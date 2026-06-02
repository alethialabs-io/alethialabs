module "key_vault" {
  source = "./modules/key-vault"

  location            = var.location
  environment         = var.environment
  project_name        = var.project_name
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  secrets             = var.custom_secrets

  tags = local.azure_default_tags
}
