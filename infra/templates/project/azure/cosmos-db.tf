locals {
  # Point-in-time restore on Cosmos DB is an ACCOUNT-level backup MODE, not a per-container flag: one
  # `backup { type = "Continuous" }` covers every container in the account. The canvas offers the
  # switch per table, so any table that asks for it puts the account in continuous mode.
  #
  # Derived HERE rather than inside modules/cosmos-db on purpose. `tofu test` evaluates the ROOT
  # module, so a derivation that lives in a child module is only reachable through an output, while a
  # root `local` can be asserted directly — checks_cosmos.tftest.hcl reads both of these.
  cosmos_point_in_time_recovery = anytrue([for c in var.cosmos_db_collections : c.point_in_time_recovery])

  # `Periodic` is Cosmos's default mode: a rolling snapshot you cannot restore to an arbitrary point
  # in time. `Continuous` is the one the switch names.
  cosmos_backup_type = local.cosmos_point_in_time_recovery ? "Continuous" : "Periodic"

  # `tier` only means anything in Continuous mode, and it must stay null otherwise. The default is
  # the FREE 7-day tier: #1838 was a switch that quietly bought a billable feature nobody asked for,
  # and defaulting to the 30-day tier would repeat the shape of that bug in a smaller way. A tenant
  # who wants 30 days sets cosmos_db_continuous_backup_tier.
  cosmos_backup_tier = local.cosmos_point_in_time_recovery ? var.cosmos_db_continuous_backup_tier : null
}

module "cosmos_db" {
  source = "./modules/cosmos-db"
  count  = var.create_cosmos_db ? 1 : 0

  location            = var.location
  environment         = var.environment
  project_name        = var.project_name
  resource_group_name = azurerm_resource_group.main.name
  kind                = var.cosmos_db_kind
  consistency_level   = var.cosmos_db_consistency_level
  collections         = var.cosmos_db_collections
  backup_type         = local.cosmos_backup_type
  backup_tier         = local.cosmos_backup_tier

  tags = local.azure_default_tags
}
