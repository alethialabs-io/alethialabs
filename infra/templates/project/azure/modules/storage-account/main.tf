resource "azurerm_storage_account" "this" {
  name                     = replace("${var.project_name}${var.environment}st", "-", "")
  resource_group_name      = var.resource_group_name
  location                 = var.location
  account_tier             = var.account_tier
  account_replication_type = var.replication_type
  min_tls_version          = "TLS1_2"

  blob_properties {
    delete_retention_policy {
      days = 7
    }
  }

  tags = var.tags
}

locals {
  containers_map = {
    for c in var.containers : c.name => c
  }
}

resource "azurerm_storage_container" "this" {
  for_each = local.containers_map

  name                  = each.key
  storage_account_id    = azurerm_storage_account.this.id
  container_access_type = each.value.access_type
}
