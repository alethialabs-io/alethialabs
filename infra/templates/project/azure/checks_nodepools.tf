# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# What AKS adds to the node-pool contract (#5535). The contract's own rules are the validations in
# variables.tf, copied verbatim and held there by assertNodePoolContract; they cannot know what a
# VM size is on Azure. These can, and they live here, not as extra validations on those variables,
# so the contract blocks stay token-equal to the reference and the nodekeys drift test reads only
# key and value rules in them.
#
# Fail-closed: a `check` only warns, and each rule below describes a pool Azure would refuse minutes
# into the apply, or one it would build wrong. The guard exists only when something was set, so a
# project that sets nothing plans exactly as before.

locals {
  # Azure VM sizes are Standard_<family><vCPUs><features>_<version>.
  aks_vm_size_pattern = "^Standard_[A-Za-z0-9_]+$"

  # The Arm64 sizes AKS runs node pools on: the Ampere Altra v5 and Cobalt 100 v6 D and E families,
  # whose feature letters start with `p` (Standard_D4ps_v5, Standard_D4pds_v5, Standard_D2pls_v5,
  # Standard_E4ps_v6). Every other size is x86-64.
  aks_arm64_vm_size_pattern = "^Standard_[DE][0-9]+pl?d?s_v[56]$"

  aks_nodepool_guard_needed = length(var.node_labels) > 0 || length(var.node_taints) > 0 || length(var.extra_node_pools) > 0
}

resource "terraform_data" "aks_nodepool_guard" {
  count = local.aks_nodepool_guard_needed ? 1 : 0

  lifecycle {
    # NODEPOOL-001 · settings with no cluster reach nothing.
    precondition {
      condition     = var.provision_aks
      error_message = "NODEPOOL-001: node_labels, node_taints and extra_node_pools are set but provision_aks is false, so no AKS cluster exists to carry them. Turn provision_aks on, or remove them."
    }

    # NODEPOOL-002 · an instance type from another cloud.
    precondition {
      condition     = alltrue([for p in var.extra_node_pools : can(regex(local.aks_vm_size_pattern, p.instance_type))])
      error_message = "NODEPOOL-002: every extra_node_pools instance_type must be an Azure VM size such as \"Standard_D4s_v5\" (amd64) or \"Standard_D4ps_v5\" (arm64). Not an Azure size: ${join(", ", [for p in var.extra_node_pools : "${p.name}=${p.instance_type}" if !can(regex(local.aks_vm_size_pattern, p.instance_type))])}."
    }

    # NODEPOOL-003 · arch and VM size disagree. An arm64 pool on an x86 size would carry the
    # alethia.io/arch=arm64 taint on x86 nodes; an amd64 pool on an Arm64 size would run amd64-only
    # images (Alethia's builds are single-arch) on Arm64 nodes with no taint to keep them off.
    precondition {
      condition     = alltrue([for p in var.extra_node_pools : (p.arch == "arm64") == can(regex(local.aks_arm64_vm_size_pattern, p.instance_type))])
      error_message = "NODEPOOL-003: an extra_node_pools pool's arch must match its VM size. AKS runs arm64 pools only on the Arm64 D and E sizes whose features start with p (Standard_D4ps_v5, Standard_D4pds_v5, Standard_D2pls_v5, Standard_E4ps_v5, and the _v6 Cobalt sizes); every other size is amd64. Mismatched: ${join(", ", [for p in var.extra_node_pools : "${p.name} (arch ${p.arch}, ${p.instance_type})" if(p.arch == "arm64") != can(regex(local.aks_arm64_vm_size_pattern, p.instance_type))])}."
    }
  }
}
