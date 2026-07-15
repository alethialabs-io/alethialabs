# Azure MANAGED REDIS (azurerm_managed_redis).
#
# The old resource — `azurerm_redis_cache` (Azure Cache for Redis) — is RETIRING and Azure now
# REFUSES to create it. A real apply returns, verbatim:
#
#   400 BadRequest: Azure Cache for Redis is retiring, create Azure Managed Redis instance
#   instead. Learn more: https://aka.ms/AzureCacheForRedisRetirement
#
# So the `cache` kind was unprovisionable on Azure for EVERY customer. It is now backed by Azure
# Managed Redis, the supported successor.
#
# Resource choice: `azurerm_managed_redis` — NOT `azurerm_redis_enterprise_cluster`, which the
# provider itself flags as "deprecated in favor of azurerm_managed_redis_cluster". Managed Redis is
# a single resource carrying an inline `default_database` (there is no separate database resource).
#
# COST (deliberate, surfaced as a variable): Managed Redis has NO Basic/Standard-equivalent low
# tier — its floor is materially above the retired Basic C0. The sku is passed through explicitly so
# an operator chooses the tier, and therefore the cost, on purpose rather than inheriting it.
#
# The output contract (hostname / port / ssl_port / primary_access_key) is preserved exactly, so
# nothing downstream (console, runner, InfraFacts) changes.

resource "azurerm_managed_redis" "this" {
  name                = "${var.project_name}-${var.environment}-redis"
  location            = var.location
  resource_group_name = var.resource_group_name
  sku_name            = var.sku_name

  high_availability_enabled = var.multi_az

  default_database {
    client_protocol   = "Encrypted" # TLS only.
    clustering_policy = "OSSCluster"
    eviction_policy   = "VolatileLRU"
  }

  tags = var.tags
}
