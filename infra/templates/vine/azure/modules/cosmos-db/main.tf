resource "azurerm_cosmosdb_account" "this" {
  name                = "${var.project_name}-${var.environment}-cosmos"
  resource_group_name = var.resource_group_name
  location            = var.location
  offer_type          = "Standard"
  kind                = var.kind

  consistency_policy {
    consistency_level = var.consistency_level
  }

  geo_location {
    location          = var.location
    failover_priority = 0
  }

  capabilities {
    name = "EnableServerless"
  }

  tags = var.tags
}

resource "azurerm_cosmosdb_sql_database" "this" {
  count = var.kind == "GlobalDocumentDB" ? 1 : 0

  name                = "${var.project_name}-${var.environment}-db"
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.this.name
}

resource "azurerm_cosmosdb_sql_container" "this" {
  for_each = var.kind == "GlobalDocumentDB" ? {
    for c in var.collections : c.name => c
  } : {}

  name                = each.value.name
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.this.name
  database_name       = azurerm_cosmosdb_sql_database.this[0].name
  partition_key_paths  = [each.value.partition_key]
  analytical_storage_ttl = each.value.analytical_storage_enabled ? -1 : null
}
