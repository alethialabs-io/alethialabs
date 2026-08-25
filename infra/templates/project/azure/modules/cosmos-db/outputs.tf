output "account_endpoint" {
  description = "The endpoint URL of the Cosmos DB account"
  value       = azurerm_cosmosdb_account.this.endpoint
}

output "account_id" {
  description = "The resource ID of the Cosmos DB account"
  value       = azurerm_cosmosdb_account.this.id
}

output "primary_key" {
  description = "The primary key for the Cosmos DB account"
  value       = azurerm_cosmosdb_account.this.primary_key
  sensitive   = true
}

output "database_name" {
  description = "The name of the SQL database (empty string if kind is MongoDB)"
  value       = var.kind == "GlobalDocumentDB" ? azurerm_cosmosdb_sql_database.this[0].name : ""
}

# Read off the RESOURCE, not off `var.backup_type`. An output echoing the input would still pass if
# the `backup` block were deleted from the account, which is precisely the state #1838 shipped.
#
# `try(one(…))` rather than a bare `[0]` index for the same reason: with no `backup` block the
# attribute is an EMPTY list, and indexing it crashes evaluation — which aborts the whole test run
# before a single assertion is graded, reporting a template error instead of the missing backup.
# null lets checks_cosmos.tftest.hcl name what is actually wrong.
output "backup_mode" {
  description = "The backup mode the account is planned with — Continuous when point-in-time restore was requested; null if no backup block is declared at all."
  value       = try(one(azurerm_cosmosdb_account.this.backup).type, null)
}

output "backup_tier" {
  description = "The continuous-backup retention tier the account is planned with; null in Periodic mode."
  value       = try(one(azurerm_cosmosdb_account.this.backup).tier, null)
}

# Read off the RESOURCE, same rule as backup_mode above: echoing var.replica_regions back would
# still pass if the dynamic geo_location block were deleted. Keyed by region because geo_location
# is a SET — list order is not meaningful to assert on.
output "geo_locations" {
  description = "Map of region → failover_priority the account is planned with — the primary at 0 plus one entry per replica region."
  value = {
    for g in azurerm_cosmosdb_account.this.geo_location :
    g.location => g.failover_priority
  }
}

output "serverless" {
  description = "Whether the account is planned with the EnableServerless capability — false once any table asked for global replicas (serverless is single-region-only)."
  value       = contains([for c in azurerm_cosmosdb_account.this.capabilities : c.name], "EnableServerless")
}

output "partition_key_paths" {
  description = "Map of container name → the partition key PATH actually planned. Exposed so the rooting of a bare attribute name (`pk` → `/pk`) is assertable: Cosmos rejects an unrooted path at apply, and only a real apply would otherwise have caught it."
  value = {
    for name, c in azurerm_cosmosdb_sql_container.this :
    name => c.partition_key_paths
  }
}
