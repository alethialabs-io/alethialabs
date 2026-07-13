################################################################################
# Locals
################################################################################

locals {
  name_prefix = "${var.project_name}-${var.environment}"

  common_tags = merge(var.tags, {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "opentofu"
  })
}

################################################################################
# AKS Cluster
################################################################################

# API-server IP allow-list (AVD-AZU-0041) is suppressed in infra/.trivyignore: it's
# customer-specific (the external runner + operator kubectl need access), so default-locking
# would break provisioning. Left customer-configurable per environment. (RBAC is enabled above.)
resource "azurerm_kubernetes_cluster" "this" {
  name                = var.cluster_name
  location            = var.location
  resource_group_name = var.resource_group_name
  dns_prefix          = var.cluster_name
  kubernetes_version  = var.cluster_version

  # --- Identity -----------------------------------------------------------
  identity {
    type = "SystemAssigned"
  }

  workload_identity_enabled = true
  oidc_issuer_enabled       = true

  # Kubernetes RBAC (AVD-AZU-0042) — safe to enable unconditionally.
  role_based_access_control_enabled = true

  # AAD-integrated cluster-admin (BYOC B4.1). Rendered only when Entra admin group
  # object IDs are supplied — an empty list leaves the block off so the cluster keeps
  # plain Kubernetes RBAC (unchanged). azurerm 4.x dropped the `managed`/`azuread`
  # args: AAD RBAC is always managed, so the block carries only admin_group_object_ids.
  dynamic "azure_active_directory_role_based_access_control" {
    for_each = length(var.admin_group_object_ids) > 0 ? [1] : []
    content {
      admin_group_object_ids = var.admin_group_object_ids
    }
  }

  # API-server IP allow-list (BYOC B4.1, AVD-AZU-0041). Rendered only when authorized
  # ranges are supplied — an empty list leaves the block off so the API server stays
  # open to all source IPs (the pre-existing customer-configurable default).
  dynamic "api_server_access_profile" {
    for_each = length(var.authorized_ip_ranges) > 0 ? [1] : []
    content {
      authorized_ip_ranges = var.authorized_ip_ranges
    }
  }

  # --- Default node pool --------------------------------------------------
  default_node_pool {
    name                 = "default"
    vm_size              = var.machine_types[0]
    vnet_subnet_id       = var.vnet_subnet_id
    os_disk_size_gb      = var.disk_size_gb
    node_count           = var.node_desired_size
    min_count            = var.node_min_size
    max_count            = var.node_max_size
    auto_scaling_enabled = true
    max_pods             = 110

    upgrade_settings {
      max_surge = "10%"
    }
  }

  # --- Network profile ----------------------------------------------------
  network_profile {
    network_plugin    = "azure"
    network_policy    = "calico"
    load_balancer_sku = "standard"
    service_cidr      = "172.16.0.0/16"
    dns_service_ip    = "172.16.0.10"
  }

  tags = local.common_tags
}

################################################################################
# Additional node pools (for extra machine types beyond the first)
################################################################################

resource "azurerm_kubernetes_cluster_node_pool" "extra" {
  count = length(var.machine_types) > 1 ? length(var.machine_types) - 1 : 0

  name                  = "pool${count.index + 1}"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.this.id
  vm_size               = var.machine_types[count.index + 1]
  vnet_subnet_id        = var.vnet_subnet_id
  os_disk_size_gb       = var.disk_size_gb
  node_count            = var.node_desired_size
  min_count             = var.node_min_size
  max_count             = var.node_max_size
  auto_scaling_enabled  = true
  max_pods              = 110

  tags = local.common_tags
}
