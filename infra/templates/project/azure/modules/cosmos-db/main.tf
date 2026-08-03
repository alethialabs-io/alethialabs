resource "azurerm_cosmosdb_account" "this" {
  # Derived at the template root (checks_naming.tf, local.azure_cosmos_account_name), not here:
  # Cosmos caps account names at 44 characters and a local inside a module is unreachable from
  # `tofu test`. The readable "<project_name>-<environment>-cosmos" form is preserved exactly.
  name                = var.account_name
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

  # Point-in-time restore. `Continuous` is what the canvas's point_in_time_recovery switch means on
  # Cosmos, and until #1838 nothing here requested it at all — the switch was wired to Synapse Link
  # analytical storage instead, which is a different, separately-billed feature and not a backup.
  #
  # `tier` is only legal in Continuous mode and is null otherwise; the root module derives both.
  backup {
    type = var.backup_type
    tier = var.backup_tier
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

  name                   = each.value.name
  resource_group_name    = var.resource_group_name
  account_name           = azurerm_cosmosdb_account.this.name
  database_name          = azurerm_cosmosdb_sql_database.this[0].name
  partition_key_paths    = [each.value.partition_key]
  analytical_storage_ttl = each.value.analytical_storage_enabled ? -1 : null
}
