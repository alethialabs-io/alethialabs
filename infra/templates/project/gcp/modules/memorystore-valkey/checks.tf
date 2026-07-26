# The endpoint is what a service binding resolves to. A null one is not an error anywhere downstream —
# `resolveBindings` records an unresolved binding and omits the env var — so the workload starts and
# fails on first connect. That is exactly how the AWS Valkey module shipped outputs-less (#1420), so
# it is asserted here at PLAN rather than discovered at runtime.
check "instance_endpoint_is_resolvable" {
  assert {
    condition     = length(google_memorystore_instance.this.discovery_endpoints) > 0
    error_message = "The Valkey instance published no discovery endpoint — every service binding to this cache would silently resolve to nothing."
  }
}

# Topology must match the declared mode: a multi-shard instance in CLUSTER_DISABLED is rejected by the
# API, and a single-shard instance in CLUSTER mode changes the client protocol without anyone asking.
check "cluster_mode_matches_shard_count" {
  assert {
    condition     = var.shard_count > 1 ? google_memorystore_instance.this.mode == "CLUSTER" : google_memorystore_instance.this.mode == "CLUSTER_DISABLED"
    error_message = "mode '${google_memorystore_instance.this.mode}' does not match shard_count ${var.shard_count}."
  }
}
