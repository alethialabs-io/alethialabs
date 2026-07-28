# The endpoint a service binding resolves to. The Redis module exposes `host`/`port`; this exposes the
# same two names so the root can emit ONE pair of cache outputs whichever engine is running — a
# service bound to "the cache" must not have to know.
#
# Memorystore for Valkey publishes its address through the PSC auto-connection rather than a top-level
# `host` attribute, so it is projected out here.

output "host" {
  description = "Hostname or IP address clients connect to"
  value       = try(google_memorystore_instance.this.discovery_endpoints[0].address, null)
}

output "port" {
  description = "Port the instance listens on"
  value       = try(google_memorystore_instance.this.discovery_endpoints[0].port, null)
}
