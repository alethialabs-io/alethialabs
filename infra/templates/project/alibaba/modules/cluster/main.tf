# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.6"
  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = ">= 1.230"
    }
  }
}

################################################################################
# ACK managed Kubernetes cluster
################################################################################

resource "alicloud_cs_managed_kubernetes" "this" {
  name         = var.cluster_name
  cluster_spec = "ack.pro.small"
  version      = var.cluster_version

  vswitch_ids = var.vswitch_ids

  pod_cidr     = var.pod_cidr
  service_cidr = var.service_cidr

  new_nat_gateway      = false
  slb_internet_enabled = true

  deletion_protection = false

  # RRSA (RAM Roles for Service Accounts) — ACK's workload identity. Creates the
  # cluster's OIDC issuer + RAM OIDC provider so in-cluster components (e.g. the
  # external-secrets operator) can assume least-privilege RAM roles per service
  # account instead of sharing the node instance role. In-place on existing
  # clusters (>= 1.22) per Alibaba docs; verify no replacement in a live plan.
  enable_rrsa = true

  tags = var.tags
}

################################################################################
# Default node pool
################################################################################

resource "alicloud_cs_kubernetes_node_pool" "default" {
  node_pool_name = "${var.cluster_name}-default"
  cluster_id     = alicloud_cs_managed_kubernetes.this.id
  vswitch_ids    = var.vswitch_ids
  instance_types = var.instance_types

  system_disk_category = "cloud_essd"
  system_disk_size     = var.disk_size_gb

  desired_size = var.node_desired_size

  scaling_config {
    min_size = var.node_min_size
    max_size = var.node_max_size
  }

  tags = var.tags
}

################################################################################
# Kubeconfig — current provider recommends the cluster credential data source
# over the deprecated inline kube_config attribute.
################################################################################

data "alicloud_cs_cluster_credential" "this" {
  cluster_id = alicloud_cs_managed_kubernetes.this.id
}
