# Azure MANAGED REDIS. The retired Azure Cache for Redis (azurerm_redis_cache) can no longer be
# created — Azure returns "Azure Cache for Redis is retiring, create Azure Managed Redis instance
# instead" — so the cache kind is now backed by Microsoft.Cache/redisEnterprise.
#
# Continuity: callers still set the legacy `azure_cache_sku` (Basic/Standard/Premium). Managed Redis
# has a single sku_name and NO low tier, so that knob is MAPPED rather than passed through. An
# operator who wants an exact tier sets `azure_cache_sku_name` and it wins.
locals {
  # Legacy tier -> Managed Redis sku. Balanced_B0 is the smallest Managed Redis offering (the
  # Enterprise_*/EnterpriseFlash_* family belongs to the older redisEnterprise resource, which the
  # provider itself deprecates — azurerm_managed_redis only accepts Balanced_/MemoryOptimized_/
  # ComputeOptimized_/FlashOptimized_ skus). An operator can bypass the map entirely by setting
  # azure_cache_sku_name.
  azure_cache_sku_map = {
    Basic    = "Balanced_B0"
    Standard = "Balanced_B1"
    Premium  = "Balanced_B3"
  }
  azure_cache_sku_name = coalesce(
    var.azure_cache_sku_name,
    lookup(local.azure_cache_sku_map, var.azure_cache_sku, "Balanced_B0"),
  )
}

module "azure_cache" {
  source = "./modules/azure-cache-redis"
  count  = var.create_azure_cache ? 1 : 0

  depends_on = [module.vnet]

  location            = var.location
  environment         = var.environment
  project_name        = var.project_name
  resource_group_name = azurerm_resource_group.main.name

  sku_name = local.azure_cache_sku_name
  multi_az = var.azure_cache_multi_az

  tags = local.azure_default_tags
}
