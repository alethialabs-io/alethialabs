# Endpoints. Without these the module provisions a cache nothing can reach: `resolveBindings`
# (packages/core/manifests) resolves a service's cache binding from the root's
# `redis_primary_endpoint_address` output, and a missing value is recorded as an unresolved binding
# and the env var is simply omitted — the workload starts and fails on first connect.
#
# The upstream serverless-cache module returns the endpoint as a BLOCK (address + port), so the
# address is projected out here to match the shape the redis module already emits.

output "valkey_primary_endpoint_address" {
  description = "Hostname clients connect to (the serverless cache's primary endpoint)"
  value       = try(module.elasticache_serverless_valkey.serverless_cache_endpoint[0].address, null)
}

output "valkey_reader_endpoint_address" {
  description = "Hostname for read-only connections, when the cache exposes one"
  value       = try(module.elasticache_serverless_valkey.serverless_cache_reader_endpoint[0].address, null)
}

output "valkey_port" {
  description = "Port the cache listens on"
  value       = try(module.elasticache_serverless_valkey.serverless_cache_endpoint[0].port, null)
}
