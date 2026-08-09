# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# ACK node-shape gates (template-parity: system-disk performance + interruptible capacity).
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.
#
# These are `terraform_data` preconditions, not bare `check` blocks, because a `check` NEVER blocks
# an apply. Every condition below describes a knob tofu ACCEPTS and Alibaba then IGNORES: the plan
# is clean, the apply is clean, and the customer is billed for a disk or a node pool that performs
# nothing like what they configured. A warning does not cover that; the plan has to stop. The
# matching `check` blocks are rendered alongside so the same violation is legible at plan time.
#
# NOT gated on `var.provision_ack`: every variable read here defaults to the value the module
# already produced, so a project that asked for nothing passes whether or not it has a cluster, and
# a node-pool knob set on a project with no node pool is itself worth stopping — it reaches nothing.

# ── CLUSTER-001 · ESSD performance level belongs to cloud_essd ───────────────────────────────────
# Alibaba splits what AWS spells as one `iops` number into two category-coupled arguments.
# system_disk_performance_level is read only on cloud_essd; on any other category the API drops it.
check "ack_performance_level_needs_essd" {
  assert {
    condition     = var.ack_disk_performance_level == null || var.ack_disk_category == "cloud_essd"
    error_message = "CLUSTER-001: ack_disk_performance_level is only honored on ack_disk_category = \"cloud_essd\" (got \"${var.ack_disk_category}\"); terraform_data.ack_node_shape_guard blocks apply."
  }
}

# ── CLUSTER-002 · provisioned IOPS belongs to cloud_auto ─────────────────────────────────────────
check "ack_provisioned_iops_needs_cloud_auto" {
  assert {
    condition     = var.ack_disk_provisioned_iops == null || var.ack_disk_category == "cloud_auto"
    error_message = "CLUSTER-002: ack_disk_provisioned_iops is only honored on ack_disk_category = \"cloud_auto\" (got \"${var.ack_disk_category}\"); terraform_data.ack_node_shape_guard blocks apply."
  }
}

# ── CLUSTER-003 · a price-limited spot pool needs a price limit ──────────────────────────────────
# SpotWithPriceLimit with no ceilings is the shape that reads as a cost control and is not one: ACK
# takes the strategy and has no ceiling to apply it against.
check "ack_price_limited_spot_has_a_limit" {
  assert {
    condition     = var.ack_node_capacity_type != "SpotWithPriceLimit" || length(var.ack_spot_price_limit) > 0
    error_message = "CLUSTER-003: ack_node_capacity_type = \"SpotWithPriceLimit\" requires at least one ack_spot_price_limit entry; terraform_data.ack_node_shape_guard blocks apply."
  }
}

# ── CLUSTER-004 · bid ceilings without a bidding strategy reach nothing ──────────────────────────
# The inverse, and the one a `check` alone would let ship: the ceilings are configured, the node
# pool is on-demand, and the module renders no spot_price_limit block at all.
check "ack_price_limits_need_a_spot_strategy" {
  assert {
    condition     = length(var.ack_spot_price_limit) == 0 || var.ack_node_capacity_type == "SpotWithPriceLimit"
    error_message = "CLUSTER-004: ack_spot_price_limit is only rendered when ack_node_capacity_type = \"SpotWithPriceLimit\" (got \"${var.ack_node_capacity_type}\"); terraform_data.ack_node_shape_guard blocks apply."
  }
}

# Fail-closed apply gate for all four. No bypass variable, for the same reason checks_compat.tf has
# none: a waiver is a runner-layer concern, deliberately not exposed in the template.
resource "terraform_data" "ack_node_shape_guard" {
  lifecycle {
    precondition {
      condition     = var.ack_disk_performance_level == null || var.ack_disk_category == "cloud_essd"
      error_message = "CLUSTER-001: ack_disk_performance_level requires ack_disk_category = \"cloud_essd\" (got \"${var.ack_disk_category}\"). Apply blocked fail-closed — on any other category Alibaba accepts the node pool and drops the level, so the disk would run at its baseline while the config claims a PL tier."
    }

    precondition {
      condition     = var.ack_disk_provisioned_iops == null || var.ack_disk_category == "cloud_auto"
      error_message = "CLUSTER-002: ack_disk_provisioned_iops requires ack_disk_category = \"cloud_auto\" (got \"${var.ack_disk_category}\"). Apply blocked fail-closed — provisioned IOPS is a cloud_auto feature; on cloud_essd use ack_disk_performance_level instead."
    }

    precondition {
      condition     = var.ack_node_capacity_type != "SpotWithPriceLimit" || length(var.ack_spot_price_limit) > 0
      error_message = "CLUSTER-003: ack_node_capacity_type = \"SpotWithPriceLimit\" needs at least one ack_spot_price_limit entry. Apply blocked fail-closed — a price-limited pool with no limit reads as a cost control and is not one."
    }

    precondition {
      condition     = length(var.ack_spot_price_limit) == 0 || var.ack_node_capacity_type == "SpotWithPriceLimit"
      error_message = "CLUSTER-004: ack_spot_price_limit is only rendered under ack_node_capacity_type = \"SpotWithPriceLimit\" (got \"${var.ack_node_capacity_type}\"). Apply blocked fail-closed — the ceilings would be configured and never applied."
    }
  }
}
