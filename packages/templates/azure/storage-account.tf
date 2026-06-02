module "storage_account" {
  source = "./modules/storage-account"
  count  = var.create_storage_account ? 1 : 0

  location            = var.location
  environment         = var.environment
  project_name        = var.project_name
  resource_group_name = azurerm_resource_group.main.name
  account_tier        = var.storage_account_tier
  replication_type    = var.storage_account_replication
  containers          = var.storage_containers

  tags = local.azure_default_tags
}
