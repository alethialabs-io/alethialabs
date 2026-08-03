locals {
  containers_map = {
    for c in var.containers : c.name => c
  }

  # Blob versioning is an ACCOUNT property in azurerm (`blob_properties.versioning_enabled`), and a
  # project gets exactly one storage account — so N per-bucket answers must collapse to one boolean.
  #
  # ANYTRUE, not alltrue, and the direction is the whole decision. `anytrue` can version a container
  # nobody asked to version: that costs storage and loses nothing. `alltrue` would silently ignore a
  # user who explicitly asked for versioning, and the first overwrite destroys data they believed
  # was recoverable. Between a bill and a data-loss surprise, take the bill.
  #
  # This coarsening is a real product fact, not an implementation detail, so the canvas discloses it
  # on Azure rather than letting one bucket's switch quietly change every other bucket's behaviour.
  blob_versioning = anytrue([for c in var.containers : c.versioning_enabled])

  # Azure refuses a container-level public grant while the ACCOUNT forbids nested public items, so
  # `access_type = "blob"` would be accepted by the API and then behave as private. This term keeps
  # the account permission exactly as wide as the containers actually need: false when every
  # container is private (tighter than azurerm's own default of true), true only when one is not.
  allow_public_blobs = anytrue([for c in var.containers : c.access_type != "private"])
}

resource "azurerm_storage_account" "this" {
  name                     = replace("${var.project_name}${var.environment}st", "-", "")
  resource_group_name      = var.resource_group_name
  location                 = var.location
  account_tier             = var.account_tier
  account_replication_type = var.replication_type
  min_tls_version          = "TLS1_2"

  # Set EXPLICITLY rather than left to the provider default, so a future default flip — azurerm's
  # own, a policy, or a Trivy-driven hardening pass — cannot silently turn every public container
  # back into a private one while the canvas still shows the switch as on.
  allow_nested_items_to_be_public = local.allow_public_blobs

  blob_properties {
    # Neither this nor the block is ForceNew (azurerm 4.x: TypeBool, Optional, Default false), so
    # toggling it updates the account in place. It cannot replace the account, which matters here
    # more than usual: replacement would destroy every container in the project at once.
    versioning_enabled = local.blob_versioning

    delete_retention_policy {
      days = 7
    }
  }

  tags = var.tags
}

resource "azurerm_storage_container" "this" {
  for_each = local.containers_map

  name               = each.key
  storage_account_id = azurerm_storage_account.this.id
  # The module has always declared and read `access_type`; the provider used to send the RESOURCE's
  # spelling, `container_access_type`, so the value landed on a name nothing read and every
  # container was created private whichever way the switch was set.
  container_access_type = each.value.access_type
}
