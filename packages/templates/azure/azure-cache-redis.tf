module "azure_cache" {
  source = "./modules/azure-cache-redis"
  count  = var.create_azure_cache ? 1 : 0

  depends_on = [module.vnet]

  location            = var.location
  environment         = var.environment
  project_name        = var.project_name
  resource_group_name = azurerm_resource_group.main.name
  sku                 = var.azure_cache_sku
  family              = var.azure_cache_family
  capacity            = var.azure_cache_capacity
  redis_version       = var.azure_cache_redis_version
  subnet_id           = var.provision_vnet ? module.vnet[0].subnet_id : var.vnet_id

  tags = local.azure_default_tags
}
