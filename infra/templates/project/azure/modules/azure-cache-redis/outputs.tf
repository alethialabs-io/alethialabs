# Output CONTRACT unchanged from the retired azurerm_redis_cache module, so nothing downstream
# (console, runner, InfraFacts) changes. Only the backing resource moved to Azure Managed Redis,
# whose port + access keys live on the inline `default_database` block.

output "hostname" {
  description = "The hostname of the Redis cache"
  value       = azurerm_managed_redis.this.hostname
}

output "port" {
  description = "The port of the Redis cache. Managed Redis is TLS-only (the retired Azure Cache for Redis exposed 6379 non-TLS + 6380 TLS)."
  value       = azurerm_managed_redis.this.default_database[0].port
}

output "ssl_port" {
  description = "The TLS port. Managed Redis serves TLS on its single port — there is no separate non-TLS port, so this equals `port`."
  value       = azurerm_managed_redis.this.default_database[0].port
}

output "primary_access_key" {
  description = "The primary access key for the Redis cache"
  value       = azurerm_managed_redis.this.default_database[0].primary_access_key
  sensitive   = true
}
