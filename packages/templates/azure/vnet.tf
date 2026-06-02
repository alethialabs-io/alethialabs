module "vnet" {
  source = "./modules/vnet"
  count  = var.provision_vnet ? 1 : 0

  location            = var.location
  environment         = var.environment
  project_name        = var.project_name
  vnet_cidr           = var.vnet_cidr
  single_nat_gateway  = var.single_nat_gateway
  resource_group_name = azurerm_resource_group.main.name

  labels = local.azure_default_tags
}
