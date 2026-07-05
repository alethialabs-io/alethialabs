################################################################################
# Locals
################################################################################

data "azurerm_client_config" "current" {}

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

  # --- Authn / authz ------------------------------------------------------
  # Azure AD + Azure RBAC for Kubernetes authorization (AVD-AZU-0042). Local admin accounts stay
  # enabled by default so bootstrap/first-run tooling keeps working; a hardened deploy can set
  # local_account_disabled = true once AAD group access is wired.
  azure_active_directory_role_based_access_control {
    azure_rbac_enabled = true
    tenant_id          = data.azurerm_client_config.current.tenant_id
  }
  local_account_disabled = var.local_account_disabled

  # --- API server access --------------------------------------------------
  # Restrict the public API server to an operator-supplied allowlist (AVD-AZU-0041). Empty = no
  # restriction (public); a real deploy passes its egress/CIDR ranges or fronts a private cluster.
  dynamic "api_server_access_profile" {
    for_each = length(var.api_server_authorized_ip_ranges) > 0 ? [1] : []
    content {
      authorized_ip_ranges = var.api_server_authorized_ip_ranges
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
