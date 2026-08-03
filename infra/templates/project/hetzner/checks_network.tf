# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Pod/service/network CIDR-topology invariants (Cilium native routing).
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

check "pods_services_within_network" {
  # Cilium native routing over the Hetzner private network requires pods and
  # services to live INSIDE network_cidr (ipv4NativeRoutingCIDR = network_cidr),
  # so node/host routes + the private-network firewall cover them and cross-node
  # pod->apiserver works. Disjoint CIDRs break it (verified on real infra).
  assert {
    condition     = local.pods_services_in_super
    error_message = "pod_cidr and service_cidr must each be a SUBNET of network_cidr (e.g. network 10.0.0.0/16, pod 10.0.128.0/17, service 10.0.96.0/19). A pod/service CIDR outside network_cidr breaks cross-node pod->apiserver routing on Hetzner."
  }
}

check "cidrs_distinct" {
  # Within the supernet, the pod, service, and node subnets must not overlap.
  assert {
    condition     = local.cidrs_distinct
    error_message = "pod_cidr, service_cidr and the node subnet (first /24 of network_cidr) must be mutually non-overlapping."
  }
}

# ── Bringing your own network (#1816) ─────────────────────────────────────────────────
#
# `provision_network = false` means "attach the network I already have". WARN companion first,
# then the gate: everything downstream — the node subnet, every server's private IP, the
# firewall's intra-cluster rules and Cilium's native-routing CIDR — is derived from the network
# the data source resolves, so an unresolvable one does not degrade, it produces a cluster whose
# datapath is wrong.
check "existing_network_id_present" {
  assert {
    condition     = var.provision_network || length(trimspace(var.network_id)) > 0
    error_message = "provision_network is false (attach an existing network) but network_id is empty; supply the hcloud network's id or name."
  }
}

# Fail-closed. Same shape as gcp/checks_network.tf's brownfield_subnet_guard: a `check` block
# only WARNS, and a warning stops nothing — the cluster is still built on the wrong network.
resource "terraform_data" "byo_network_guard" {
  lifecycle {
    precondition {
      condition     = var.provision_network || length(trimspace(var.network_id)) > 0
      error_message = "provision_network is false but network_id is empty. Name the existing hcloud network (numeric id or name), or set provision_network = true to create one. Apply blocked fail-closed."
    }

    # The pod and service CIDRs must sit inside the network that actually resolved, not inside
    # the network_cidr the caller asked for — on the brownfield path those are different values,
    # and Cilium native routing is decided by the real one. Reuses the same locals the checks
    # above assert, which now read local.network_ip_range.
    precondition {
      condition     = var.provision_network || (local.pods_services_in_super && local.cidrs_distinct)
      error_message = "The existing network's ip_range does not contain non-overlapping pod_cidr and service_cidr. Cilium runs in native-routing mode over this network, so pods/services outside its range break cross-node pod->apiserver traffic. Apply blocked fail-closed."
    }
  }
}
