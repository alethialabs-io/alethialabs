# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# Invariants asserted at plan-time so misconfiguration fails loudly.
#
# CONVENTION: this file holds only the CORE, rarely-touched invariants (plus the shared locals). A new
# feature's checks go in their own checks_<feature>.tf — OpenTofu loads every *.tf in the directory,
# and a single shared append-point is what made concurrent feature branches conflict here repeatedly.

locals {
  # Pairwise CIDR-overlap detection using pure Terraform builtins.
  # Two CIDRs overlap iff the network address of the one with the LONGER prefix
  # (smaller block) still maps into the shorter-prefix block. We test this by
  # masking each network address down to the shorter prefix length and comparing.
  # Cilium native routing over the Hetzner private network requires pod_cidr and
  # service_cidr to be SUBNETS of network_cidr (see variables.tf / cilium.tf), so
  # the node's `network_cidr dev eth1` route + the private-network firewall cover
  # pod/service traffic. So the invariants are: (1) pod & service are inside
  # network_cidr, and (2) pod, service, and the node subnet are mutually disjoint.
  _distinct_pairs = {
    pod_service  = [local.pod_cidr, local.service_cidr]
    pod_node     = [local.pod_cidr, local.node_subnet_cidr]
    service_node = [local.service_cidr, local.node_subnet_cidr]
  }

  _cidr_overlap = {
    for k, pair in local._distinct_pairs : k => (
      # shorter prefix length (the bigger of the two blocks)
      cidrhost("${cidrhost(pair[0], 0)}/${min(tonumber(split("/", pair[0])[1]), tonumber(split("/", pair[1])[1]))}", 0)
      ==
      cidrhost("${cidrhost(pair[1], 0)}/${min(tonumber(split("/", pair[0])[1]), tonumber(split("/", pair[1])[1]))}", 0)
    )
  }

  # child ⊂ parent iff child's prefix is longer/equal AND child's network address,
  # masked to the PARENT's prefix length, equals the parent's network address.
  _subnet_of = {
    pod_in_network     = [local.pod_cidr, local.network_ip_range]
    service_in_network = [local.service_cidr, local.network_ip_range]
  }
  _is_subnet = {
    for k, pair in local._subnet_of : k => (
      tonumber(split("/", pair[0])[1]) >= tonumber(split("/", pair[1])[1])
      &&
      cidrhost("${cidrhost(pair[0], 0)}/${tonumber(split("/", pair[1])[1])}", 0) == cidrhost(pair[1], 0)
    )
  }

  cidrs_distinct         = !anytrue(values(local._cidr_overlap))
  pods_services_in_super = alltrue(values(local._is_subnet))

  # Kubernetes major/minor parsed from the RESOLVED render version (render_kube_version in cilium.tf
  # already maps "" -> the "1.35.6" default), e.g. "1.35.6" -> 1 / 35. -1 when unparseable, so a garbage
  # version fails the COMPAT-001 guard closed rather than passing vacuously. The window literals in the
  # guard below are the compat-matrix bounds (packages/core/compat/matrix.json): k8s_cloud.hetzner = 1.35
  # (single supported minor); components talos 1.31-1.36, cilium <=1.35, hcloud-csi 1.34-1.36. These are
  # the same couplings packages/core/compat/couplings_drift_test.go (#1214) proves in Go — keep both in
  # lockstep with matrix.json.
  hetzner_k8s_major = can(tonumber(split(".", local.render_kube_version)[0])) ? tonumber(split(".", local.render_kube_version)[0]) : -1
  hetzner_k8s_minor = can(tonumber(split(".", local.render_kube_version)[1])) ? tonumber(split(".", local.render_kube_version)[1]) : -1
}

check "cluster_name_non_empty" {
  assert {
    condition     = length(trimspace(local.cluster_name)) > 0
    error_message = "talos_cluster_name (project_name-environment) must be non-empty; the pipeline configures kubeconfig only when it is set."
  }
}

check "control_plane_present" {
  assert {
    condition     = var.control_plane_count >= 1
    error_message = "control_plane_count must be at least 1."
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
