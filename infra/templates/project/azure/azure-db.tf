module "azure_db" {
  source = "./modules/azure-db"
  count  = var.create_azure_db ? 1 : 0

  depends_on = [module.vnet]

  location            = var.location
  environment         = var.environment
  project_name        = var.project_name
  resource_group_name = azurerm_resource_group.main.name

  engine                = var.azure_db_engine
  engine_version        = var.azure_db_engine_version
  sku_name              = var.azure_db_sku_name
  storage_mb            = var.azure_db_storage_mb
  high_availability     = var.azure_db_high_availability
  backup_retention_days = var.azure_db_backup_retention_days
  port                  = var.azure_db_port
  iam_auth              = var.azure_db_iam_auth
  subnet_id             = var.provision_vnet ? module.vnet[0].database_subnet_id : var.vnet_id

  # BYOC B4.1 DB CIDR allow-list (default-empty = behavior-preserving)
  allowed_cidrs = var.azure_db_allowed_cidrs

  tags = local.azure_default_tags
}
