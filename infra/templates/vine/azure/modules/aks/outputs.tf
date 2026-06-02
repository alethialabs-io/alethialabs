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
  description = "Auto-generated resource group containing AKS agent pool nodes"
  value       = azurerm_kubernetes_cluster.this.node_resource_group
}
