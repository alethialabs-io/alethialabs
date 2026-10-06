output "cluster_name" {
  description = "Name of the AKS cluster"
  value       = azurerm_kubernetes_cluster.this.name
}

output "cluster_endpoint" {
  description = "Kubernetes API server endpoint"
  value       = azurerm_kubernetes_cluster.this.kube_config[0].host
}

output "cluster_ca_certificate" {
  description = "Base64-encoded CA certificate for the cluster"
  value       = azurerm_kubernetes_cluster.this.kube_config[0].cluster_ca_certificate
  sensitive   = true
}

output "client_certificate" {
  description = "Base64-encoded client certificate for authentication"
  value       = azurerm_kubernetes_cluster.this.kube_config[0].client_certificate
  sensitive   = true
}

output "client_key" {
  description = "Base64-encoded client key for authentication"
  value       = azurerm_kubernetes_cluster.this.kube_config[0].client_key
  sensitive   = true
}

output "kube_config_raw" {
  description = "Raw kubeconfig for the AKS cluster"
  value       = azurerm_kubernetes_cluster.this.kube_config_raw
  sensitive   = true
}

output "node_resource_group" {
  description = "Resource group containing the AKS agent pool nodes. Set explicitly from var.node_resource_group (#1921), no longer auto-derived by Azure; read back off the cluster so it reflects what Azure actually holds."
  value       = azurerm_kubernetes_cluster.this.node_resource_group
}

output "oidc_issuer_url" {
  description = "The OIDC issuer URL of the AKS cluster (for federated workload identity)"
  value       = azurerm_kubernetes_cluster.this.oidc_issuer_url
}

output "cluster_id" {
  description = "Resource id of the AKS cluster (the target of the root's control-plane diagnostic setting and data collection rule association)"
  value       = azurerm_kubernetes_cluster.this.id
}

# Read off the PLANNED resource so the root's tofu test asserts what the cluster will carry, not
# what the root passed in. Null when the add-on is off.
output "oms_agent_workspace_id" {
  description = "Log Analytics workspace the Container Insights add-on reports to; null when the add-on is off"
  value       = one(azurerm_kubernetes_cluster.this.oms_agent[*].log_analytics_workspace_id)
}

# Read off the PLANNED pools so the root's tofu test asserts what each pool will carry, not what the
# root passed in (#5535). Every pool this module makes, keyed by its AKS name.
output "node_pools" {
  description = "Per node pool (default, pool1..N, spot, and each named pool), the planned name, mode, vm_size, sizes, priority, labels, taints, subnet, OS disk and max_pods."
  value = merge(
    {
      default = {
        name            = azurerm_kubernetes_cluster.this.default_node_pool[0].name
        mode            = "System"
        vm_size         = azurerm_kubernetes_cluster.this.default_node_pool[0].vm_size
        node_count      = azurerm_kubernetes_cluster.this.default_node_pool[0].node_count
        min_count       = azurerm_kubernetes_cluster.this.default_node_pool[0].min_count
        max_count       = azurerm_kubernetes_cluster.this.default_node_pool[0].max_count
        priority        = "Regular"
        node_labels     = azurerm_kubernetes_cluster.this.default_node_pool[0].node_labels
        node_taints     = null
        vnet_subnet_id  = azurerm_kubernetes_cluster.this.default_node_pool[0].vnet_subnet_id
        os_disk_size_gb = azurerm_kubernetes_cluster.this.default_node_pool[0].os_disk_size_gb
        os_disk_type    = azurerm_kubernetes_cluster.this.default_node_pool[0].os_disk_type
        max_pods        = azurerm_kubernetes_cluster.this.default_node_pool[0].max_pods
      }
    },
    {
      for p in concat(azurerm_kubernetes_cluster_node_pool.extra, azurerm_kubernetes_cluster_node_pool.spot, values(azurerm_kubernetes_cluster_node_pool.named)) : p.name => {
        name            = p.name
        mode            = p.mode
        vm_size         = p.vm_size
        node_count      = p.node_count
        min_count       = p.min_count
        max_count       = p.max_count
        priority        = p.priority
        node_labels     = p.node_labels
        node_taints     = p.node_taints
        vnet_subnet_id  = p.vnet_subnet_id
        os_disk_size_gb = p.os_disk_size_gb
        os_disk_type    = p.os_disk_type
        max_pods        = p.max_pods
      }
    },
  )
}

output "node_labels_argument" {
  description = "The node_labels argument the default and positional pools render: null when node_labels is empty, so they plan exactly as before (#5535)."
  value       = local.node_labels_argument
}
