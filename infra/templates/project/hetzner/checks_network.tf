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
