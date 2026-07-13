# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# Invariants asserted at plan-time so misconfiguration fails loudly.

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
    pod_service  = [var.pod_cidr, var.service_cidr]
    pod_node     = [var.pod_cidr, local.node_subnet_cidr]
    service_node = [var.service_cidr, local.node_subnet_cidr]
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
    pod_in_network     = [var.pod_cidr, var.network_cidr]
    service_in_network = [var.service_cidr, var.network_cidr]
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
}

check "cluster_name_non_empty" {
  assert {
    condition     = length(trimspace(local.cluster_name)) > 0
    error_message = "talos_cluster_name (project_name-environment) must be non-empty; the pipeline configures kubeconfig only when it is set."
  }
}

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

  # NOTE: the volume-label invariant (HCLOUD_VOLUME_EXTRA_LABELS carrying cluster=<name>) is
  # deliberately NOT asserted here. A `check` block only emits a WARNING — it does not fail
  # plan or apply — and that invariant guards a real money leak (an unlabelled pvc-* volume is
  # unreclaimable by the cluster-scoped teardown and bills forever). It is enforced as a
  # HARD failure by the `terraform_data.csi_volume_label_guard` lifecycle precondition in
  # csi.tf. Keep it there; a warning is not a gate.
}

check "bucket_names_non_empty" {
  # Every requested bucket must carry a non-empty name (it becomes part of the S3 bucket
  # name), and S3 credentials must be present when buckets are requested.
  assert {
    condition     = alltrue([for b in var.buckets : length(trimspace(b.name)) > 0])
    error_message = "Every Object Storage bucket must have a non-empty name."
  }

  assert {
    condition     = length(var.buckets) == 0 || (trimspace(var.hetzner_s3_access_key) != "" && trimspace(var.hetzner_s3_secret_key) != "")
    error_message = "Provisioning Hetzner Object Storage buckets requires hetzner_s3_access_key and hetzner_s3_secret_key (generate them in the Hetzner Console — there is no API to mint them)."
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

check "classification_base_labels_win" {
  # Platform base labels must WIN over classification_tags: for every base key, the merged
  # default_labels must carry the base value. This keeps `cluster` (the label the SHARED-with-prod
  # teardown sweep scopes on) authoritative — a renamed classification dimension can never shadow it.
  assert {
    condition = alltrue([
      for k, v in local.base_labels : local.default_labels[k] == v
    ])
    error_message = "A classification_tags entry overrode a platform base label in default_labels; base labels must sit on the merge RHS and win (notably `cluster`)."
  }
}

check "classification_labels_present" {
  # No classification label may be silently dropped: every key in var.classification_tags must
  # survive into default_labels verbatim, unless a base key legitimately overrode it. This lands the
  # mandatory alethia_project-id / alethia_environment-id sweep handles on every hcloud resource.
  assert {
    condition = alltrue([
      for k, v in var.classification_tags :
      local.default_labels[k] == v || contains(keys(local.base_labels), k)
    ])
    error_message = "A classification_tags entry was dropped from default_labels; classification/sweep-handle labels must reach hcloud resources + volumes."
  }
}
