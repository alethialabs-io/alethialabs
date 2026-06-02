output "hostname" {
  description = "The hostname of the Redis cache"
  value       = azurerm_redis_cache.this.hostname
}

output "port" {
  description = "The non-SSL port of the Redis cache"
  value       = azurerm_redis_cache.this.port
}

output "ssl_port" {
  description = "The SSL port of the Redis cache"
  value       = azurerm_redis_cache.this.ssl_port
}

output "primary_access_key" {
  description = "The primary access key for the Redis cache"
  value       = azurerm_redis_cache.this.primary_access_key
  sensitive   = true
}
