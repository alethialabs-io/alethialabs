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

  # Build a map keyed by name_suffix for for_each
  buckets_map = {
    for bucket in var.buckets : bucket.name_suffix => bucket
  }

  # Flatten IAM bindings so each gets its own resource
  iam_bindings = merge([
    for bucket in var.buckets : {
      for binding in coalesce(bucket.iam_bindings, []) :
      "${bucket.name_suffix}-${binding.role}-${binding.member}" => {
        name_suffix = bucket.name_suffix
        role        = binding.role
        member      = binding.member
      }
    }
  ]...)
}

################################################################################
# GCS buckets
################################################################################

resource "google_storage_bucket" "this" {
  for_each = local.buckets_map

  name     = "${local.name_prefix}-${each.key}"
  project  = var.project_id
  location = var.region

  storage_class               = each.value.storage_class
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  force_destroy = var.environment != "production"

  versioning {
    enabled = each.value.versioning
  }

  dynamic "lifecycle_rule" {
    for_each = each.value.lifecycle_age != null ? [each.value.lifecycle_age] : []
    content {
      condition {
        age = lifecycle_rule.value
      }
      action {
        type = "Delete"
      }
    }
  }

  # Keep only the latest noncurrent version if versioning is enabled
  dynamic "lifecycle_rule" {
    for_each = each.value.versioning ? [1] : []
    content {
      condition {
        num_newer_versions = 3
        with_state         = "ARCHIVED"
      }
      action {
        type = "Delete"
      }
    }
  }

  labels = merge(var.labels, {
    environment = var.environment
    managed-by  = "terraform"
    bucket      = each.key
  })
}

################################################################################
# Optional IAM bindings
################################################################################

resource "google_storage_bucket_iam_member" "this" {
  for_each = local.iam_bindings

  bucket = google_storage_bucket.this[each.value.name_suffix].name
  role   = each.value.role
  member = each.value.member
}
