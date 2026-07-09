# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# Invariants asserted at plan-time so misconfiguration fails loudly.

locals {
  # Pairwise CIDR-overlap detection using pure Terraform builtins.
  # Two CIDRs overlap iff the network address of the one with the LONGER prefix
  # (smaller block) still maps into the shorter-prefix block. We test this by
  # masking each network address down to the shorter prefix length and comparing.
  _cidr_pairs = {
    pod_service     = [var.pod_cidr, var.service_cidr]
    pod_network     = [var.pod_cidr, var.network_cidr]
    service_network = [var.service_cidr, var.network_cidr]
  }

  _cidr_overlap = {
    for k, pair in local._cidr_pairs : k => (
      # shorter prefix length (the bigger of the two blocks)
      cidrhost("${cidrhost(pair[0], 0)}/${min(tonumber(split("/", pair[0])[1]), tonumber(split("/", pair[1])[1]))}", 0)
      ==
      cidrhost("${cidrhost(pair[1], 0)}/${min(tonumber(split("/", pair[0])[1]), tonumber(split("/", pair[1])[1]))}", 0)
    )
  }

  cidrs_distinct = !anytrue(values(local._cidr_overlap))
}

check "cluster_name_non_empty" {
  assert {
    condition     = length(trimspace(local.cluster_name)) > 0
    error_message = "talos_cluster_name (project_name-environment) must be non-empty; the pipeline configures kubeconfig only when it is set."
  }
}

check "cidrs_distinct" {
  # Pod, service, and node/network CIDRs must not overlap, or routing breaks.
  assert {
    condition     = local.cidrs_distinct
    error_message = "network_cidr, pod_cidr and service_cidr must be mutually non-overlapping."
  }
}

check "control_plane_present" {
  assert {
    condition     = var.control_plane_count >= 1
    error_message = "control_plane_count must be at least 1."
  }
}

check "csi_storageclass_present" {
  # Persistent volumes are required (in-cluster Postgres/Redis/etc). Assert the
  # Hetzner CSI driver + a DEFAULT hcloud-volumes StorageClass are rendered.
  assert {
    condition     = local.csi_has_driver && local.csi_has_storageclass
    error_message = "Hetzner CSI driver + StorageClass must be present in the rendered manifests."
  }

  assert {
    condition     = local.csi_has_default_sc
    error_message = "The hcloud-volumes StorageClass must be marked as the cluster default (is-default-class=true)."
  }
}

check "arch_matches_server_type" {
  # cax* server types are arm64; cx*/ccx* are amd64. Catch obvious mismatches.
  assert {
    condition = (
      (startswith(var.control_plane_server_type, "cax") && var.control_plane_arch == "arm64") ||
      (!startswith(var.control_plane_server_type, "cax") && var.control_plane_arch == "amd64")
    )
    error_message = "control_plane_arch must match control_plane_server_type (cax* => arm64, cx*/ccx* => amd64)."
  }

  assert {
    condition = (
      (startswith(var.worker_server_type, "cax") && var.worker_arch == "arm64") ||
      (!startswith(var.worker_server_type, "cax") && var.worker_arch == "amd64")
    )
    error_message = "worker_arch must match worker_server_type (cax* => arm64, cx*/ccx* => amd64)."
  }
}
