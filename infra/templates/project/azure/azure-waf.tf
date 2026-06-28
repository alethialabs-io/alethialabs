module "azure_waf" {
  source = "./modules/azure-waf"
  count  = var.azure_waf_enabled ? 1 : 0

  location            = var.location
  environment         = var.environment
  project_name        = var.project_name
  resource_group_name = azurerm_resource_group.main.name
  rules               = var.azure_waf_rules

  tags = local.azure_default_tags
}
