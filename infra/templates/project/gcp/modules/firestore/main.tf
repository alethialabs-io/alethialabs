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
