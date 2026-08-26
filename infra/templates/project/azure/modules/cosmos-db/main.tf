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

  # Cross-region failover only means something once there is a second region to fail over to.
  automatic_failover_enabled = length(var.replica_regions) > 0

  geo_location {
    location          = var.location
    failover_priority = 0
  }

  # Replica regions (#2158): the union of every table's global_replicas, primary excluded and
  # deduplicated at the root. Priorities follow list order after the primary's 0.
  dynamic "geo_location" {
    for_each = var.replica_regions
    content {
      location          = geo_location.value
      failover_priority = geo_location.key + 1
    }
  }

  # Serverless is single-region-only, so it is CONDITIONAL on no replicas being asked for
  # (#2158, human decision 2026-08-10): a table requesting global replicas switches the account
  # onto provisioned throughput. `capabilities` is create-time, so on an EXISTING account this
  # flip is a REPLACEMENT — the inspector states both consequences on the field.
  dynamic "capabilities" {
    for_each = length(var.replica_regions) == 0 ? ["EnableServerless"] : []
    content {
      name = capabilities.value
    }
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

  name                = each.value.name
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.this.name
  database_name       = azurerm_cosmosdb_sql_database.this[0].name

  # Cosmos wants a PATH; the product collects an ATTRIBUTE NAME.
  #
  # One `partition_key` field feeds two clouds with different rules. DynamoDB takes a bare attribute
  # name (`pk`) — the console labels the field "Hash key", which is DynamoDB's own word for it — and
  # Cosmos takes a JSON path that must begin with `/`. So the identical component that provisions on
  # aws fails on azure with
  #
  #   The partition key component definition path 'pk' could not be accepted, failed near position '0'
  #
  # which is what the first azure full bar hit (32836351919). Any customer who types `pk` in the
  # console — the obvious thing to type, and correct for aws — gets that error.
  #
  # Normalised here rather than at the caller because the caller is not one place: the console form,
  # the CLI, the promotion diff and test/e2e/maxconfig.go all supply this field, and a fix in one of
  # them leaves the other three broken. An already-rooted path is passed through untouched, so the
  # module's own `/id` default and anyone already storing `/pk` are unaffected.
  partition_key_paths = [
    startswith(each.value.partition_key, "/") ? each.value.partition_key : "/${each.value.partition_key}"
  ]

  analytical_storage_ttl = each.value.analytical_storage_enabled ? -1 : null
}
