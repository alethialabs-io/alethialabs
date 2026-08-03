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
