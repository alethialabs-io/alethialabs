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
  subnet_id             = try(module.vnet[0].database_subnet_id, null) != null ? module.vnet[0].database_subnet_id : var.vnet_id

  # MySQL validates Entra tokens with an identity attached to the SERVER (PostgreSQL takes an inline
  # authentication block instead). The dedicated db_admin identity doubles as it, so no third identity
  # exists and the app identity still never holds admin rights. Empty ⇒ Entra auth stays off.
  aad_identity_id = local.enable_mysql_entra ? one(azurerm_user_assigned_identity.db_admin[*].id) : ""

  # BYOC B4.1 DB CIDR allow-list (default-empty = behavior-preserving)
  allowed_cidrs = var.azure_db_allowed_cidrs

  tags = local.azure_default_tags
}

################################################################################
# Log exports (azure_db_log_exports) — CUSTOMIZABILITY-PARITY top gap #5
################################################################################
# A diagnostic setting on the Flexible Server, for whichever engine module.azure_db provisioned.
# Empty (the default) creates nothing, so no server gains a setting or a log bill it did not ask for.
#
# The destination rule is a PRECONDITION, not a fallback: the template's own workspace when
# aks_log_retention_days created one, otherwise azure_db_log_workspace_id, otherwise the plan FAILS
# naming both. A list of categories that ships nowhere would be the silent no-op this guard exists
# to prevent.

locals {
  azure_db_is_postgres = var.azure_db_engine == "postgres"

  # Read off the RESOURCE, never off aks_log_retention_days: the workspace exists only when the
  # cluster does, and reading the variable here would also make that knob look like the database's.
  azure_db_log_workspace = one(azurerm_log_analytics_workspace.aks[*].id) != null ? one(azurerm_log_analytics_workspace.aks[*].id) : var.azure_db_log_workspace_id

  # PostgreSQL's categories all start "PostgreSQL", MySQL's all start "MySql" — the variable's
  # validation already pinned the full set, so the prefix is an exact engine test here.
  azure_db_log_exports_match_engine = alltrue([for c in var.azure_db_log_exports : startswith(c, local.azure_db_is_postgres ? "PostgreSQL" : "MySql")])
}

resource "terraform_data" "azure_db_log_exports_guard" {
  count = var.create_azure_db && length(var.azure_db_log_exports) > 0 ? 1 : 0

  lifecycle {
    precondition {
      condition     = local.azure_db_log_workspace != ""
      error_message = "azure_db_log_exports is set but there is nowhere to send the logs: set aks_log_retention_days (the template then creates a Log Analytics workspace) or azure_db_log_workspace_id (an existing workspace's resource id)."
    }
    precondition {
      condition     = local.azure_db_log_exports_match_engine
      error_message = "azure_db_log_exports names categories of the other engine. The ${var.azure_db_engine} Flexible Server emits ${local.azure_db_is_postgres ? "PostgreSQLLogs, PostgreSQLFlexSessions, PostgreSQLFlexQueryStoreRuntime, PostgreSQLFlexQueryStoreWaitStats, PostgreSQLFlexTableStats and PostgreSQLFlexDatabaseXacts" : "MySqlSlowLogs and MySqlAuditLogs"}."
    }
  }
}

resource "azurerm_monitor_diagnostic_setting" "azure_db" {
  count = var.create_azure_db && length(var.azure_db_log_exports) > 0 ? 1 : 0

  depends_on = [terraform_data.azure_db_log_exports_guard]

  name                       = "azure-db-logs"
  target_resource_id         = module.azure_db[0].server_id
  log_analytics_workspace_id = local.azure_db_log_workspace

  dynamic "enabled_log" {
    for_each = toset(var.azure_db_log_exports)
    content {
      category = enabled_log.value
    }
  }
}

################################################################################
# Server parameters (azure_db_database_flags) — CUSTOMIZABILITY-PARITY top gap #7
################################################################################
# One configuration resource per entry, for the provisioned engine only — the two engines have
# different resources (PostgreSQL keys on server_id, MySQL on resource group + server name). Empty
# creates none, and the server keeps Azure's defaults exactly as before. The TLS parameters are
# refused by the variable's validation, so nothing here can switch transport encryption off.

resource "azurerm_postgresql_flexible_server_configuration" "azure_db" {
  for_each = var.create_azure_db && local.azure_db_is_postgres ? var.azure_db_database_flags : {}

  name      = each.key
  server_id = module.azure_db[0].server_id
  value     = each.value
}

resource "azurerm_mysql_flexible_server_configuration" "azure_db" {
  for_each = var.create_azure_db && !local.azure_db_is_postgres ? var.azure_db_database_flags : {}

  name                = each.key
  resource_group_name = azurerm_resource_group.main.name
  server_name         = module.azure_db[0].server_name
  value               = each.value
}
