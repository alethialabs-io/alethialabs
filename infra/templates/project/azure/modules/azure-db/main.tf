################################################################################
# Locals
################################################################################

locals {
  name_prefix = "${var.project_name}-${var.environment}"

  is_postgres = var.engine == "postgres"

  # Sanitize server name: Azure requires lowercase alphanumeric + hyphens only
  server_name = lower(replace("${local.name_prefix}-db", "_", "-"))

  db_name = replace("${var.project_name}_${var.environment}", "-", "_")

  common_tags = merge(var.tags, {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "opentofu"
  })
}

################################################################################
# Admin credentials
################################################################################

resource "random_password" "admin" {
  length  = 24
  special = true
}

################################################################################
# DNS Zone — required for private access on flexible server
################################################################################

resource "azurerm_private_dns_zone" "postgres" {
  count = local.is_postgres ? 1 : 0

  name                = "${local.server_name}.private.postgres.database.azure.com"
  resource_group_name = var.resource_group_name

  tags = local.common_tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  count = local.is_postgres ? 1 : 0

  name                  = "${local.server_name}-dns-link"
  private_dns_zone_name = azurerm_private_dns_zone.postgres[0].name
  resource_group_name   = var.resource_group_name
  virtual_network_id    = local.vnet_id_from_subnet

  tags = local.common_tags
}

locals {
  # Extract the VNet ID from the subnet ID
  # Subnet ID format: /subscriptions/.../resourceGroups/.../providers/Microsoft.Network/virtualNetworks/<vnet>/subnets/<subnet>
  subnet_parts        = split("/", var.subnet_id)
  vnet_id_from_subnet = join("/", slice(local.subnet_parts, 0, length(local.subnet_parts) - 2))
}

################################################################################
# PostgreSQL Flexible Server
################################################################################

resource "azurerm_postgresql_flexible_server" "this" {
  count = local.is_postgres ? 1 : 0

  name                          = local.server_name
  location                      = var.location
  resource_group_name           = var.resource_group_name
  version                       = var.engine_version
  sku_name                      = var.sku_name
  storage_mb                    = var.storage_mb
  administrator_login           = "pgadmin"
  administrator_password        = random_password.admin.result
  backup_retention_days         = var.backup_retention_days
  delegated_subnet_id           = var.subnet_id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres[0].id
  public_network_access_enabled = false
  zone                          = "1"

  dynamic "authentication" {
    for_each = var.iam_auth ? [1] : []
    content {
      active_directory_auth_enabled = true
      password_auth_enabled         = true
    }
  }

  dynamic "high_availability" {
    for_each = var.high_availability ? [1] : []
    content {
      mode                      = "ZoneRedundant"
      standby_availability_zone = "2"
    }
  }

  tags = local.common_tags

  depends_on = [
    azurerm_private_dns_zone_virtual_network_link.postgres[0],
  ]
}

################################################################################
# PostgreSQL Database
################################################################################

resource "azurerm_postgresql_flexible_server_database" "this" {
  count = local.is_postgres ? 1 : 0

  name      = local.db_name
  server_id = azurerm_postgresql_flexible_server.this[0].id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

################################################################################
# MySQL Flexible Server (placeholder — add implementation when needed)
################################################################################

# resource "azurerm_mysql_flexible_server" "this" {
#   count = local.is_postgres ? 0 : 1
#   ...
# }

# resource "azurerm_mysql_flexible_server_database" "this" {
#   count = local.is_postgres ? 0 : 1
#   ...
# }
