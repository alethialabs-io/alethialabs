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

  # CORS is `blob_properties.cors_rule` — an ACCOUNT property, like versioning above — so the
  # per-container lists are UNIONED into one rule (#1995). distinct() keeps the rule stable when two
  # containers name the same origin, and sort() keeps it stable against list order, so re-ordering
  # buckets on the canvas does not produce a plan diff.
  #
  # Union, not intersection, and the direction matters the same way anytrue does above: a container
  # may be reachable from an origin nobody asked to allow for it, which is a wider grant than
  # strictly needed. The alternative silently REFUSES an origin the user explicitly allowed, and
  # that surfaces as a CORS error in the browser against infrastructure they already configured —
  # the failure this issue is about. The coarsening is disclosed on the canvas.
  cors_origins = sort(distinct(flatten([for c in var.containers : c.cors_origins])))
}

resource "azurerm_storage_account" "this" {
  # Derived at the template root (checks_naming.tf, local.azure_storage_account_name). This
  # rendered 23 of the permitted 24 characters on the e2e nightly — one character of headroom —
  # and the root derivation also lowercases and strips every non-alphanumeric, which this
  # hyphen-only replace() did not.
  name                     = var.account_name
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

    # Only when an origin was actually allowed: an empty cors_rule is not "no CORS", it is a rule
    # matching nothing, and it churns the plan for every project that never set one.
    dynamic "cors_rule" {
      for_each = length(local.cors_origins) > 0 ? [1] : []
      content {
        allowed_origins = local.cors_origins
        # The methods a browser preflight can ask for on blob storage. Scoped to reads plus the
        # writes the account already permits, rather than "*", so allowing an origin does not also
        # widen what that origin may DO.
        allowed_methods    = ["GET", "HEAD", "OPTIONS", "PUT", "POST"]
        allowed_headers    = ["*"]
        exposed_headers    = ["*"]
        max_age_in_seconds = 3600
      }
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
