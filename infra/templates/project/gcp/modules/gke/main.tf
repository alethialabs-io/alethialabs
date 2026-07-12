terraform {
  required_version = ">= 1.3"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
  }
}

locals {
  node_pool_name = "${var.cluster_name}-default-pool"

  merged_labels = merge(var.labels, {
    environment = var.environment
    managed-by  = "opentofu"
  })
}

################################################################################
# GKE Cluster
################################################################################

resource "google_container_cluster" "cluster" {
  name     = var.cluster_name
  project  = var.project_id
  location = var.region

  # When Autopilot is enabled, GKE manages node pools automatically.
  enable_autopilot = var.enable_autopilot

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

  name     = local.node_pool_name
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
    disk_size_gb = var.disk_size_gb
    disk_type    = var.disk_type

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
