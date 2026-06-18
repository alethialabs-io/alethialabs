module "acr" {
  source = "./modules/acr"
  count  = var.provision_acr ? 1 : 0

  location            = var.location
  environment         = var.environment
  project_name        = var.project_name
  resource_group_name = azurerm_resource_group.main.name
  sku                 = var.acr_sku

  tags = local.azure_default_tags
}
