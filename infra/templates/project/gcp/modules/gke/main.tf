terraform {
  required_version = ">= 1.3"

  required_providers {
    google = {
      source = "hashicorp/google"
      # >= 6.50.0 for `node_config.boot_disk` on google_container_node_pool (provisioned_iops /
      # provisioned_throughput). 6.50.0 is the version the block was VERIFIED present in, by reading
      # `tofu providers schema -json`, NOT necessarily the version that introduced it — lowering this
      # floor means re-reading the schema at the candidate version, not guessing. The root already
      # resolves 6.50.0, so this raises no version anybody is actually running.
      version = ">= 6.50.0"
    }
  }
}

locals {
  merged_labels = merge(var.labels, {
    environment = var.environment
    managed-by  = "opentofu"
  })

  # See node_config below: the flat disk attributes and the nested `boot_disk` block are two
  # spellings of one disk, and only `boot_disk` carries provisioned performance. This predicate
  # picks which spelling is rendered, and false — the default — is the pre-existing shape.
  boot_disk_configured = var.volume_iops != null || var.volume_throughput != null
}

################################################################################
# GKE Cluster
################################################################################

resource "google_container_cluster" "cluster" {
  name     = var.cluster_name
  project  = var.project_id
  location = var.region

  # When Autopilot is enabled, GKE manages node pools automatically.
  #
  # MUST be null (not false) when Autopilot is off. The provider's ConflictsWith fires on the
  # attribute being SET AT ALL — not on its value — so `enable_autopilot = false` still collides
  # with network_policy, remove_default_node_pool and addons_config.network_policy_config, making
  # EVERY standard (non-Autopilot) plan fail with "Conflicting configuration arguments".
  # `tofu validate` does not catch this; only a real plan does. Found by the first real GCP apply.
  enable_autopilot = var.enable_autopilot ? true : null

  # For Standard mode: remove the default node pool and manage our own.
  # These fields are ignored when enable_autopilot = true.
  dynamic "node_config" {
    for_each = var.enable_autopilot ? [] : [1]
    content {
      # Minimal config for the default node pool that will be removed
    }
  }
  remove_default_node_pool = var.enable_autopilot ? null : true
  initial_node_count       = var.enable_autopilot ? null : 1

  min_master_version = var.cluster_version

  network    = var.network_name
  subnetwork = var.subnet_name

  # VPC-native cluster using alias IPs
  ip_allocation_policy {
    cluster_secondary_range_name  = var.pod_ip_range_name
    services_secondary_range_name = var.service_ip_range_name
  }

  # Private cluster: nodes have no public IPs, but the control plane endpoint
  # is publicly accessible (restricted by master_authorized_networks_config).
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }

  master_authorized_networks_config {
    dynamic "cidr_blocks" {
      for_each = var.master_authorized_cidr_blocks
      content {
        cidr_block   = cidr_blocks.value.cidr_block
        display_name = cidr_blocks.value.display_name
      }
    }
  }

  # Workload Identity
  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  # Release channel for automated upgrades
  release_channel {
    channel = "REGULAR"
  }

  # Namespace-placement tenant isolation (#1012 — cloud parity with the AWS Fabric fix).
  # GKE already closes both halves the AWS EKS template had to fix:
  #   1. NetworkPolicy ENFORCEMENT: Calico NP is enabled here (Standard) so the guardrail
  #      bundle's default-deny NetworkPolicy actually enforces between tenant namespaces —
  #      it is NOT a no-op the way an unconfigured VPC-CNI was on AWS. Autopilot enforces
  #      NetworkPolicy natively via Dataplane V2, so the block is omitted there.
  #   2. Metadata / node-credential lockdown: the node pool sets
  #      `workload_metadata_config { mode = "GKE_METADATA" }` (GKE Metadata Server), which
  #      conceals the raw GCE metadata endpoint from Pods — a tenant Pod cannot read the node
  #      SA token, the GCP analogue of the EKS IMDS-hop-limit lockdown. Workloads get scoped
  #      identity via Workload Identity instead.
  dynamic "network_policy" {
    for_each = var.enable_autopilot ? [] : [1]
    content {
      enabled  = true
      provider = "CALICO"
    }
  }

  addons_config {
    http_load_balancing {
      disabled = false
    }
    horizontal_pod_autoscaling {
      disabled = false
    }
    dynamic "network_policy_config" {
      for_each = var.enable_autopilot ? [] : [1]
      content {
        disabled = false
      }
    }
  }

  # Logging and monitoring
  logging_service    = "logging.googleapis.com/kubernetes"
  monitoring_service = "monitoring.googleapis.com/kubernetes"

  resource_labels = local.merged_labels

  # Prevent accidental destruction
  deletion_protection = false

  lifecycle {
    ignore_changes = [
      # Node count is managed by the autoscaler
      initial_node_count,
    ]
  }
}

################################################################################
# Default Node Pool (Standard mode only)
################################################################################

resource "google_container_node_pool" "default" {
  count = var.enable_autopilot ? 0 : 1

  # Derived at the template root (checks_naming.tf, local.gke_node_pool_name), not here: GKE caps
  # this at 39 characters and the readable form overflows on ordinary names, so the name is built
  # defensively — and it is built where a `tofu test` can reach it, which this module is not (its
  # computed-only `master_auth` block cannot be mocked). See #1716 / #1746.
  name     = var.node_pool_name
  project  = var.project_id
  location = var.region
  cluster  = google_container_cluster.cluster.name

  initial_node_count = var.node_desired_size

  autoscaling {
    min_node_count = var.node_min_size
    max_node_count = var.node_max_size
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type = var.machine_types[0]

    # The flat pair and the nested `boot_disk` block are two spellings of the same disk, and
    # `boot_disk` is the ONLY one that accepts provisioned IOPS/throughput. They are rendered
    # MUTUALLY EXCLUSIVELY rather than both at once: the flat pair is the exact shape every existing
    # project already plans, and `boot_disk` replaces it whole the moment a performance figure is
    # asked for. With both figures null (the default) `local.boot_disk_configured` is false, the
    # dynamic block yields nothing, and the rendered node_config is byte-identical to the one this
    # module produced before these knobs existed — which is the only claim about the default path
    # that can be made without a real GCP plan, and it is made by construction.
    disk_size_gb = local.boot_disk_configured ? null : var.disk_size_gb
    disk_type    = local.boot_disk_configured ? null : var.disk_type

    dynamic "boot_disk" {
      for_each = local.boot_disk_configured ? [1] : []
      content {
        size_gb                = var.disk_size_gb
        disk_type              = var.disk_type
        provisioned_iops       = var.volume_iops
        provisioned_throughput = var.volume_throughput
      }
    }

    # Interruptible capacity (aws parity: eks_ng_capacity_type). Both attributes are optional and
    # NOT computed, so writing the `false` default explicitly is indistinguishable from omitting
    # them — which is what this module did until now. The root guards the mutual exclusion at plan
    # time (checks_cluster.tf); the API rejects both-at-once far later.
    spot        = var.spot
    preemptible = var.preemptible

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    # Workload Identity on the node pool
    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    labels = local.merged_labels

    metadata = {
      disable-legacy-endpoints = "true"
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }
  }

  lifecycle {
    ignore_changes = [
      initial_node_count,
    ]
  }
}

################################################################################
# Workload Identity IAM
################################################################################
# NOTE (least-privilege): the former project-level roles/iam.workloadIdentityUser
# binding for kube-system/default was removed. GKE Workload Identity works via the
# per-GSA google_service_account_iam_member bindings (each add-on's GSA↔KSA pair,
# e.g. workload-identity.tf's external_dns_wi); this project-scoped grant to the
# default KSA was legacy/no-op and forced the provisioner to hold project setIamPolicy
# (owner-equivalent). Add-ons that need WI bind their own GSA at the GSA scope.
