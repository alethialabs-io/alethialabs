terraform {
  required_version = "~> 1.1"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0, < 7.0"
    }
  }
}

################################################################################
# Locals
################################################################################

locals {
  name_prefix = "${var.project_name}-${var.environment}"
  database_id = "${local.name_prefix}-firestore"
  location    = coalesce(var.location_id, var.region)
}

################################################################################
# Firestore database
################################################################################

resource "google_firestore_database" "this" {
  name        = local.database_id
  project     = var.project_id
  location_id = local.location
  type        = var.database_type

  concurrency_mode            = "PESSIMISTIC"
  app_engine_integration_mode = "DISABLED"

  # Point-in-time recovery. The DISABLED arm is spelled out rather than left to null on purpose:
  # `null` hands the provider its own default, and the OFF position then reads identically to
  # "never asked" — which is how a switch that does nothing passes for a switch that works.
  #
  # SAFE TO TOGGLE. `point_in_time_recovery_enablement` is not ForceNew in hashicorp/google (checked
  # at v5.0.0, the constraint floor, and at v6.50.0, the pinned version — the ForceNew fields are
  # location_id, name, cmek_config, database_edition, tags and project). It is an in-place PATCH, so
  # flipping it never reaches the deletion_policy = "DELETE" below.
  point_in_time_recovery_enablement = var.point_in_time_recovery ? "POINT_IN_TIME_RECOVERY_ENABLED" : "POINT_IN_TIME_RECOVERY_DISABLED"

  delete_protection_state = var.environment == "production" ? "DELETE_PROTECTION_ENABLED" : "DELETE_PROTECTION_DISABLED"

  # The provider DEFAULTS deletion_policy to ABANDON: `tofu destroy` then drops the database from
  # state and reports success while the real Firestore database is left behind in the project —
  # a silent orphan (observed on a real destroy: 29 resources "destroyed", database still live).
  # Non-production must actually delete; production keeps ABANDON so a destroy can't nuke real data.
  deletion_policy = var.environment == "production" ? "ABANDON" : "DELETE"
}

################################################################################
# Optional Firestore indexes
################################################################################

resource "google_firestore_index" "this" {
  for_each = { for idx, index in var.indexes : idx => index }

  project    = var.project_id
  database   = google_firestore_database.this.name
  collection = each.value.collection

  dynamic "fields" {
    for_each = each.value.fields
    content {
      field_path   = fields.value.field_path
      order        = lookup(fields.value, "order", null)
      array_config = lookup(fields.value, "array_config", null)
    }
  }

  query_scope = lookup(each.value, "query_scope", "COLLECTION")
}
