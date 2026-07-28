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
# PostgreSQL public-endpoint firewall allow-list (BYOC B4.1)
################################################################################

# One firewall rule per allow-listed CIDR. Created only when var.allowed_cidrs is
# non-empty, so the default (empty) leaves the server exactly as before — private,
# VNet-integrated, no public firewall rules. Each CIDR is expanded to its first/last
# address for the start/end IP range the resource requires.
resource "azurerm_postgresql_flexible_server_firewall_rule" "allowlist" {
  for_each = local.is_postgres ? { for cidr in var.allowed_cidrs : cidr => cidr } : {}

  name             = "allow-${replace(replace(each.value, "/", "-"), ".", "-")}"
  server_id        = azurerm_postgresql_flexible_server.this[0].id
  start_ip_address = cidrhost(each.value, 0)
  end_ip_address   = cidrhost(each.value, -1)
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
# MySQL Flexible Server
################################################################################
#
# `azure-mysql` has been a first-class engine in the catalog, the canvas radio and the Azure
# capability lane (which enumerates real MySQL versions from ARM) since the beginning — while this
# block was a three-line placeholder ending in an ellipsis. Selecting MySQL on Azure did not fail: it
# provisioned NOTHING, every output resolved null, the binding was recorded unresolved, and the
# environment reported converged (#1382).
#
# It is not the PostgreSQL resource with a different name. Against azurerm 4.x the shapes differ in
# ways that each fail at apply if assumed:
#   · storage is a BLOCK (`storage { size_gb }`), not `storage_mb`
#   · public access is `public_network_access`, without PostgreSQL's `_enabled` suffix
#   · versions are only 5.7 / 8.0.21 / 8.4
#   · the private DNS zone suffix is `.mysql.database.azure.com`
#   · Entra auth needs a user-assigned identity ON the server plus a separate administrator
#     resource — where PostgreSQL takes an inline `authentication` block

resource "azurerm_private_dns_zone" "mysql" {
  count = local.is_postgres ? 0 : 1

  name                = "${local.server_name}.private.mysql.database.azure.com"
  resource_group_name = var.resource_group_name

  tags = local.common_tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "mysql" {
  count = local.is_postgres ? 0 : 1

  name                  = "${local.server_name}-dns-link"
  private_dns_zone_name = azurerm_private_dns_zone.mysql[0].name
  resource_group_name   = var.resource_group_name
  virtual_network_id    = local.vnet_id_from_subnet

  tags = local.common_tags
}

resource "azurerm_mysql_flexible_server" "this" {
  count = local.is_postgres ? 0 : 1

  name                   = local.server_name
  location               = var.location
  resource_group_name    = var.resource_group_name
  version                = var.engine_version
  sku_name               = var.sku_name
  administrator_login    = "mysqladmin"
  administrator_password = random_password.admin.result
  backup_retention_days  = var.backup_retention_days
  delegated_subnet_id    = var.subnet_id
  private_dns_zone_id    = azurerm_private_dns_zone.mysql[0].id
  zone                   = "1"

  # Storage is a block here, and auto-grow is REQUIRED when high availability is on (the service
  # rejects the combination otherwise), so it follows the HA flag rather than being hardcoded.
  storage {
    size_gb           = ceil(var.storage_mb / 1024)
    auto_grow_enabled = var.high_availability ? true : var.storage_auto_grow
  }

  # Entra auth needs an identity ON the server; the administrator itself is a separate resource,
  # registered by the root module so the app identity never holds admin rights (#722).
  dynamic "identity" {
    for_each = var.iam_auth && var.aad_identity_id != "" ? [1] : []
    content {
      type         = "UserAssigned"
      identity_ids = [var.aad_identity_id]
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
    azurerm_private_dns_zone_virtual_network_link.mysql[0],
  ]
}

################################################################################
# MySQL public-endpoint firewall allow-list (parity with the PostgreSQL branch)
################################################################################

resource "azurerm_mysql_flexible_server_firewall_rule" "allowlist" {
  for_each = local.is_postgres ? {} : { for cidr in var.allowed_cidrs : cidr => cidr }

  name                = "allow-${replace(replace(each.value, "/", "-"), ".", "-")}"
  resource_group_name = var.resource_group_name
  server_name         = azurerm_mysql_flexible_server.this[0].name
  start_ip_address    = cidrhost(each.value, 0)
  end_ip_address      = cidrhost(each.value, -1)
}

################################################################################
# MySQL Database
################################################################################

resource "azurerm_mysql_flexible_database" "this" {
  count = local.is_postgres ? 0 : 1

  name                = local.db_name
  resource_group_name = var.resource_group_name
  server_name         = azurerm_mysql_flexible_server.this[0].name
  charset             = "utf8mb4"
  collation           = "utf8mb4_unicode_ci"
}
