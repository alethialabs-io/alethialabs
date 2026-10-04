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

output "database_id" {
  description = "Resource id of the Managed Redis default database — the resource that emits ConnectionEvents, and the target of the root's diagnostic setting"
  # Composed from the cluster id rather than read off default_database[0].id. They are the same
  # string — Managed Redis has exactly one database and Azure names it "default" — but the nested
  # block's id has no shape under a mocked provider (a block cannot be given a mock default while the
  # config also sets it), and a target the root's tofu test cannot plan is a target nothing tests.
  value = "${azurerm_managed_redis.this.id}/databases/default"
}
