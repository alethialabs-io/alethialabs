terraform {
  required_version = "~> 1.1"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0, < 7.0"
    }
  }
}

################################################################################
# Locals
################################################################################

locals {
  name_prefix = "${var.project_name}-${var.environment}"
  # Memorystore instance ids are 4–63 chars, lowercase, and must start with a letter or digit.
  instance_name = lower("${local.name_prefix}-valkey")
}

################################################################################
# Memorystore for Valkey
################################################################################
#
# A SEPARATE resource from `google_redis_instance`, not a flag on it. Memorystore's Valkey offering
# is the newer cluster-shaped product: it is sized by shards and node type rather than by a memory
# figure, and it takes its network as a PSC connection list instead of an authorized network. Wiring
# Valkey as an `engine` argument on the Redis instance — the obvious guess — is not expressible.
#
# The canvas asks for a cloud-indifferent memory size, so the module converts: shards are derived
# from that size against the node type's per-shard capacity, and never fewer than one.

resource "google_memorystore_instance" "this" {
  instance_id = local.instance_name
  project     = var.project_id
  location    = var.region

  engine_version = var.engine_version
  node_type      = var.node_type
  shard_count    = var.shard_count
  replica_count  = var.replica_count

  # CLUSTER_DISABLED keeps the single-shard shape closest to what the Redis instance provided, so a
  # project moving between engines does not silently change topology.
  mode = var.shard_count > 1 ? "CLUSTER" : "CLUSTER_DISABLED"

  desired_psc_auto_connections {
    network    = var.network_self_link
    project_id = var.project_id
  }

  labels = merge(var.labels, {
    environment = var.environment
    managed-by  = "opentofu"
  })

  deletion_protection_enabled = var.environment == "production"
}
