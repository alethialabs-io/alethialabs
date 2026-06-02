module "cosmos_db" {
  source = "./modules/cosmos-db"
  count  = var.create_cosmos_db ? 1 : 0

  location            = var.location
  environment         = var.environment
  project_name        = var.project_name
  resource_group_name = azurerm_resource_group.main.name
  kind                = var.cosmos_db_kind
  consistency_level   = var.cosmos_db_consistency_level

  tags = local.azure_default_tags
}
