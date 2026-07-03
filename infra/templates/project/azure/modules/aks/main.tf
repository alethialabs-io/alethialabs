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

# trivy:ignore:AVD-AZU-0041 API-server IP allow-list is customer-specific (the external
# runner + operator kubectl need access); default-locking it would break provisioning.
# Left customer-configurable per environment. (RBAC — AZU-0042 — is enabled above.)
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
