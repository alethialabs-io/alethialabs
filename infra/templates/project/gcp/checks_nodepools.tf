# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# What GKE adds to the node-pool contract (#5537). The contract's own rules are the validations in
# variables.tf, copied verbatim and held there by assertNodePoolContract; they cannot know what a
# machine type is on GCP, or which labels this template already puts on a node. These can, and they
# live here, not as extra validations on those variables, so the contract blocks stay token-equal
# to the reference and the nodekeys drift test reads only key and value rules in them.
#
# Fail-closed: a `check` only warns, and each rule below describes a setting Google would refuse
# minutes into the apply, one that would build a pool wrong, or one that would reach nothing and be
# dropped in silence. The guard exists only when something was set, so a project that sets nothing
# plans exactly as before. Like checks_cluster.tf, it is not gated on provision_gke: a setting with
# no cluster to carry it is itself a reason to stop.

locals {
  # A Compute Engine machine type: a family, then hyphen-separated parts, all lowercase
  # (e2-standard-4, n2d-highmem-8, t2a-standard-4, c4a-standard-8, g2-standard-4,
  # n2-custom-4-16384). An instance type from another cloud (m7g.large, Standard_D4s_v5, cx32) does
  # not match.
  gke_machine_type_pattern = "^[a-z][a-z0-9]*-[a-z0-9-]*[a-z0-9]$"

  # The Arm machine families: T2A (Ampere Altra), C4A and N4A (Google Axion), and A4X / A4X Max
  # (NVIDIA Grace; a4x-highgpu-4g, a4x-maxgpu-4g-metal). Source: the Arm column of
  # https://cloud.google.com/compute/docs/machine-resource. GCP has no naming convention that marks
  # Arm, so the list is kept by hand, in ONE place: nodekeys.GCPArmMachineFamilies
  # (packages/core/nodekeys). This literal is a copy of nodekeys.GCPArmMachineTypeRegex, and
  # packages/core/nodekeys/drift_test.go fails when they differ. Add a new Arm family THERE first.
  gke_arm64_machine_type_pattern = "^(t2a|c4a|n4a|a4x)-"

  gke_nodepool_guard_needed = length(var.node_labels) > 0 || length(var.node_taints) > 0 || length(var.extra_node_pools) > 0

  # Every user label key: node_labels and each pool's own labels.
  gke_user_node_label_keys = distinct(concat(keys(var.node_labels), flatten([for p in var.extra_node_pools : keys(p.labels)])))
}

resource "terraform_data" "gke_nodepool_guard" {
  count = local.gke_nodepool_guard_needed ? 1 : 0

  lifecycle {
    # NODEPOOL-001 · settings with no cluster reach nothing.
    precondition {
      condition     = var.provision_gke
      error_message = "NODEPOOL-001: node_labels, node_taints or extra_node_pools are set but provision_gke is false, so no GKE cluster exists to carry them. Turn provision_gke on, or remove them."
    }

    # NODEPOOL-002 · Autopilot has no node pools to add.
    precondition {
      condition     = !var.gke_enable_autopilot || length(var.extra_node_pools) == 0
      error_message = "NODEPOOL-002: extra_node_pools cannot be used with gke_enable_autopilot = true. An Autopilot cluster has no node pools you manage: GKE creates and sizes its nodes from each Pod's requests. Remove extra_node_pools, or turn gke_enable_autopilot off to manage the pools yourself."
    }

    # NODEPOOL-003 · Autopilot has no pool to label or taint either.
    precondition {
      condition     = !var.gke_enable_autopilot || (length(var.node_labels) == 0 && length(var.node_taints) == 0)
      error_message = "NODEPOOL-003: node_labels and node_taints cannot be used with gke_enable_autopilot = true. An Autopilot cluster has no node pool for the template to label or taint. Remove them, or turn gke_enable_autopilot off."
    }

    # NODEPOOL-004 · an instance type from another cloud.
    precondition {
      condition     = alltrue([for p in var.extra_node_pools : can(regex(local.gke_machine_type_pattern, p.instance_type))])
      error_message = "NODEPOOL-004: every extra_node_pools instance_type must be a Compute Engine machine type such as \"e2-standard-4\" (amd64) or \"t2a-standard-4\" (arm64). Not a GCP machine type: ${join(", ", [for p in var.extra_node_pools : "${p.name}=${p.instance_type}" if !can(regex(local.gke_machine_type_pattern, p.instance_type))])}."
    }

    # NODEPOOL-005 · arch and machine type disagree. An arm64 pool on an x86 machine would carry the
    # alethia.io/arch=arm64 taint on x86 nodes; an amd64 pool on an Arm machine would run amd64-only
    # images (Alethia's builds are single-arch) on Arm nodes.
    precondition {
      condition     = alltrue([for p in var.extra_node_pools : (p.arch == "arm64") == can(regex(local.gke_arm64_machine_type_pattern, p.instance_type))])
      error_message = "NODEPOOL-005: an extra_node_pools pool's arch must match its machine type. The Arm families are t2a, c4a, n4a and a4x (t2a-standard-4, c4a-standard-8, a4x-highgpu-4g); every other family is amd64. Mismatched: ${join(", ", [for p in var.extra_node_pools : "${p.name} (arch ${p.arch}, ${p.instance_type})" if(p.arch == "arm64") != can(regex(local.gke_arm64_machine_type_pattern, p.instance_type))])}."
    }

    # NODEPOOL-006 · a user label that would overwrite one the template sets. The template labels
    # every node with environment, service, managed-by and the project's classification_tags; a
    # user key with the same name would either replace that label or be dropped, depending on merge
    # order. Neither is said anywhere, so the plan stops instead.
    precondition {
      condition     = length(setintersection(local.gke_user_node_label_keys, keys(local.gke_platform_node_labels))) == 0
      error_message = "NODEPOOL-006: node_labels and extra_node_pools labels may not use a key the template already puts on every GKE node (${join(", ", sort(keys(local.gke_platform_node_labels)))}). Clashing: ${join(", ", sort(tolist(setintersection(local.gke_user_node_label_keys, keys(local.gke_platform_node_labels)))))}. Use another key, such as example.com/team."
    }
  }
}
