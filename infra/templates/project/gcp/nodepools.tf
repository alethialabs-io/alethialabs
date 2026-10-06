# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Node labels, node taints and extra node pools on GKE (#5537), under the cross-cloud node-pool
# contract (#5533). The variables are in variables.tf; the render every cloud shares is
# nodepool_contract_render.tf. This file only MAPS that render to what the google provider wants,
# and builds nothing from the variables a second way: the labels and taints a pool gets are read
# from local.nodepool_contract_render, so the asserted render and the applied pools cannot disagree.
#
# WHY THE EXTRA POOLS LIVE HERE AND NOT IN modules/gke. modules/gke cannot be planned under mocked
# providers (its computed-only `master_auth` block cannot be mocked; checks_cluster_optional.tftest.hcl
# records the finding), so nothing inside it can be asserted by a `tofu test`. The isolation of an
# extra pool (GKE_METADATA, shielded nodes, the node service account) is a tenant-isolation control
# and must be asserted on the PLANNED resource, so the resource is at the root, where
# nodepools.tftest.hcl plans it with the module's outputs overridden.
#
# The default pool stays in modules/gke, where it has always been: moving it would change its
# address and replace a live pool. It gains only node_labels, and only when node_labels is set.
#
# What the mapping does, and nothing else:
#
#   · LABELS. Every pool's nodes carry the labels the template has always put on the default pool
#     (local.gke_platform_node_labels, the same expression modules/gke uses), then the render's
#     labels. checks_nodepools.tf refuses a user key that collides with one of the template's, so
#     the merge order never decides anything.
#   · TAINT EFFECT SPELLING. The contract's NoSchedule / PreferNoSchedule / NoExecute become the
#     GKE API's NO_SCHEDULE / PREFER_NO_SCHEDULE / NO_EXECUTE. A taint with no value is sent with an
#     empty value, which is how the API spells "no value".
#   · NAMES. A pool is named "<cluster name>-<pool name>", through the same length-and-hash rule as
#     the default pool (checks_naming.tf), so a long cluster name cannot push it past GKE's limit.
#   · SIZE. min_size and max_size bound the WHOLE pool (total_min_node_count /
#     total_max_node_count), as on every other cloud, not each zone. initial_node_count is per zone,
#     so on a regional cluster (three zones) the pool starts with desired_size rounded up to a
#     multiple of three, but never past max_size; on a zonal cluster it starts with desired_size.
#     The autoscaler owns the count after that, so later changes to desired_size do nothing.
#   · SPOT. capacity_type spot is node_config.spot. arm64 is the machine type (t2a, c4a, n4a);
#     GKE adds its own kubernetes.io/arch=arm64:NoSchedule taint to those nodes, beside the
#     platform's alethia.io/arch=arm64:NoSchedule from the render.

locals {
  # The labels modules/gke has always put on the default pool's nodes (its local.merged_labels over
  # var.labels = local.gcp_default_labels). Written the same way here so an extra pool's nodes carry
  # exactly what a default pool node carries.
  gke_platform_node_labels = merge(local.gcp_default_labels, {
    environment = var.environment
    managed-by  = "opentofu"
  })

  # Only a Standard cluster that exists has pools to add. checks_nodepools.tf refuses the other
  # shapes when anything was set, so this never drops a pool silently.
  gke_extra_node_pools_enabled = var.provision_gke && !var.gke_enable_autopilot

  # A zone ends in "-<letter>" (locals.tf derives gcp_region_key the same way). A regional cluster
  # puts every pool in three zones, which is GKE's default and what modules/gke leaves it at.
  gke_pool_zone_count = can(regex("-[a-z]$", var.region)) ? 1 : 3

  gke_taint_effects = {
    NoSchedule       = "NO_SCHEDULE"
    PreferNoSchedule = "PREFER_NO_SCHEDULE"
    NoExecute        = "NO_EXECUTE"
  }

  # One entry per extra_node_pools item, keyed by the contract NAME: removing a pool from the middle
  # of the list removes that pool and no other.
  gke_extra_node_pools = {
    for p in var.extra_node_pools : p.name => {
      # Same rule as local.gke_node_pool_name (checks_naming.tf): the readable form while it fits
      # under GKE's 40-character pool-name limit, else 31 characters of it, "-", and 7 hex
      # characters of the FULL name's digest, so two pools sharing a prefix never collide.
      gke_name = length("${local.gke_name}-${p.name}") < 40 ? "${local.gke_name}-${p.name}" : format(
        "%s-%s",
        trimsuffix(substr("${local.gke_name}-${p.name}", 0, 31), "-"),
        substr(sha256("${local.gke_name}-${p.name}"), 0, 7),
      )
      machine_type   = p.instance_type
      total_min      = p.min_size
      total_max      = p.max_size
      initial_count  = min(ceil((p.desired_size == null ? p.min_size : p.desired_size) / local.gke_pool_zone_count), floor(p.max_size / local.gke_pool_zone_count))
      spot           = p.capacity_type == "spot"
      labels         = merge(local.gke_platform_node_labels, local.nodepool_contract_render[p.name].labels)
      taints         = [for t in local.nodepool_contract_render[p.name].taints : { key = t.key, value = t.value, effect = local.gke_taint_effects[t.effect] }]
      location_shape = p.capacity_type == "spot" ? "ANY" : "BALANCED"
    }
  }
}

# Each extra pool. Isolation parity with the default pool (modules/gke, google_container_node_pool.default)
# is the point of every line in node_config: the same node service account (none set, so both use
# the project's Compute Engine default), the GKE metadata server (without it a pod reads the node's
# credentials from the metadata endpoint), shielded nodes, legacy metadata endpoints off, the same
# OAuth scope, and the same boot disk, which GCP encrypts the same way on both. A pool may be
# cheaper because of its machine type or Spot capacity, never because it is less isolated.
# nodepools.tftest.hcl asserts each of these on the planned pool, and
# packages/core/cloud/nodepool_gcp_test.go fails if this block and the default pool's drift apart.
resource "google_container_node_pool" "extra" {
  for_each = local.gke_extra_node_pools_enabled ? local.gke_extra_node_pools : {}

  name     = each.value.gke_name
  project  = var.project_id
  location = var.region
  # The refresh-safe existence probe (scripts/check-templates-refresh-safe.mjs): under -refresh-only
  # a cluster with no module instance in state is an empty tuple, and a bare [0] aborts the plan.
  # The fallback is the name the module is given, so it names the same cluster.
  cluster = try(module.gke[0].cluster_name, null) != null ? module.gke[0].cluster_name : local.gke_name

  initial_node_count = each.value.initial_count

  autoscaling {
    total_min_node_count = each.value.total_min
    total_max_node_count = each.value.total_max
    location_policy      = each.value.location_shape
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type = each.value.machine_type

    # The default pool's two spellings of the boot disk, chosen by the same predicate
    # (modules/gke local.boot_disk_configured).
    disk_size_gb = local.gke_boot_disk_performance_requested ? null : var.gke_disk_size_gb
    disk_type    = local.gke_boot_disk_performance_requested ? null : var.gke_disk_type

    dynamic "boot_disk" {
      for_each = local.gke_boot_disk_performance_requested ? [1] : []
      content {
        size_gb                = var.gke_disk_size_gb
        disk_type              = var.gke_disk_type
        provisioned_iops       = var.gke_volume_iops
        provisioned_throughput = var.gke_volume_throughput
      }
    }

    spot = each.value.spot

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    labels = each.value.labels

    dynamic "taint" {
      for_each = each.value.taints
      content {
        key    = taint.value.key
        value  = taint.value.value
        effect = taint.value.effect
      }
    }

    metadata = {
      disable-legacy-endpoints = "true"
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }
  }

  # The autoscaler owns the node count once the pool exists; initial_node_count is where it starts.
  lifecycle {
    ignore_changes = [
      initial_node_count,
    ]
  }
}
