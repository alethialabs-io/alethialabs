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

  cache_name = local.azure_cache_name

  sku_name = local.azure_cache_sku_name
  multi_az = var.azure_cache_multi_az

  tags = local.azure_default_tags
}

################################################################################
# Cache logging (azure_cache_log_categories) — CUSTOMIZABILITY-PARITY top gap #9
################################################################################
# A diagnostic setting on the Managed Redis DATABASE. The cluster resource
# (Microsoft.Cache/redisEnterprise) emits metrics only; ConnectionEvents is a category of its
# databases, and azurerm_managed_redis always creates exactly one (its inline default_database).
#
# Same destination rule as azure_db_log_exports, and for the same reason it is a precondition:
# the template's workspace when aks_log_retention_days created one, otherwise
# azure_cache_log_workspace_id, otherwise the plan fails naming both. Empty creates nothing.

locals {
  azure_cache_log_workspace = one(azurerm_log_analytics_workspace.aks[*].id) != null ? one(azurerm_log_analytics_workspace.aks[*].id) : var.azure_cache_log_workspace_id
}

resource "terraform_data" "azure_cache_log_guard" {
  count = var.create_azure_cache && length(var.azure_cache_log_categories) > 0 ? 1 : 0

  lifecycle {
    precondition {
      condition     = local.azure_cache_log_workspace != ""
      error_message = "azure_cache_log_categories is set but there is nowhere to send the logs: set aks_log_retention_days (the template then creates a Log Analytics workspace) or azure_cache_log_workspace_id (an existing workspace's resource id)."
    }
  }
}

resource "azurerm_monitor_diagnostic_setting" "azure_cache" {
  count = var.create_azure_cache && length(var.azure_cache_log_categories) > 0 ? 1 : 0

  depends_on = [terraform_data.azure_cache_log_guard]

  name                       = "azure-cache-logs"
  target_resource_id         = module.azure_cache[0].database_id
  log_analytics_workspace_id = local.azure_cache_log_workspace

  dynamic "enabled_log" {
    for_each = toset(var.azure_cache_log_categories)
    content {
      category = enabled_log.value
    }
  }
}
