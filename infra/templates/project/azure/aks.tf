module "aks" {
  source = "./modules/aks"
  count  = var.provision_aks ? 1 : 0

  depends_on = [module.vnet]

  location            = var.location
  environment         = var.environment
  project_name        = var.project_name
  cluster_name        = local.aks_name
  cluster_version     = var.aks_cluster_version
  resource_group_name = azurerm_resource_group.main.name
  vnet_subnet_id      = var.provision_vnet ? module.vnet[0].private_subnet_id : data.azurerm_subnet.existing[0].id

  machine_types     = var.aks_instance_types
  node_min_size     = var.aks_node_min_size
  node_max_size     = var.aks_node_max_size
  node_desired_size = var.aks_node_desired_size
  disk_size_gb      = var.aks_disk_size_gb

  tags = local.azure_default_tags
}
