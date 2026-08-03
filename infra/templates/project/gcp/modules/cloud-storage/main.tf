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

  name    = "${local.name_prefix}-${each.key}"
  project = var.project_id
  # `location` is ForceNew. The root's default is null and no caller sets it today, so this
  # coalesce resolves to var.region exactly as the hardcoded value did — the attribute is honored
  # for a caller that asks, and unchanged for every bucket that already exists.
  location = coalesce(each.value.location, var.region)

  storage_class = each.value.storage_class

  # UBLA stays on for EVERY bucket, always, and is deliberately not driven by `public_access`.
  # It disables per-object ACLs, which is a different feature from public readability, and Cloud
  # Storage rejects turning it back off once a bucket has had it enabled for 90 days — a switch
  # wired here would become an apply that can never succeed on any bucket older than that.
  uniform_bucket_level_access = true

  # `public_access_prevention` is the argument that decides whether a public grant is even
  # permitted: "enforced" makes GCS refuse an allUsers binding outright, "inherited" defers to the
  # organization policy. It only stops PREVENTING public access — it grants nothing on its own,
  # which is why google_storage_bucket_iam_member.public_read below is the other half of this fix.
  public_access_prevention = each.value.public_access ? "inherited" : "enforced"

  # Preserves the existing behaviour (every non-production bucket is destroyable) while honoring a
  # caller that asks for it explicitly. Dropping the environment term would strand staging buckets.
  force_destroy = each.value.force_destroy || var.environment != "production"

  # CORS was declared by the root and discarded at this boundary, so a browser origin the user
  # configured never reached the bucket. Empty origins produce no block at all, which is the
  # behaviour every existing bucket already has.
  dynamic "cors" {
    for_each = length(each.value.cors_origins) > 0 ? [1] : []
    content {
      origin          = each.value.cors_origins
      method          = each.value.cors_methods
      response_header = ["*"]
      max_age_seconds = 3600
    }
  }

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
    managed-by  = "opentofu"
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

################################################################################
# Public read — the other half of `public_access`
################################################################################

# `public_access_prevention = "inherited"` alone would be a switch that is carried, read, and still
# does NOTHING: it stops GCS from refusing a public grant, it does not make one. Anyone reading the
# plan diff would see the bucket change and conclude the feature worked. This binding is what
# actually makes the objects readable, and the two must always ship together.
resource "google_storage_bucket_iam_member" "public_read" {
  for_each = { for k, b in local.buckets_map : k => b if b.public_access }

  bucket = google_storage_bucket.this[each.key].name
  role   = "roles/storage.objectViewer"
  member = "allUsers"

  lifecycle {
    # Fail at PLAN with a sentence, rather than mid-apply with a raw IAM error, in the two ways
    # this grant can be refused.
    #
    # The condition is the half we own: GCS rejects an allUsers binding on a bucket whose
    # public_access_prevention is "enforced". It reads the PLANNED attribute rather than
    # `each.value.public_access` on purpose — restating the input would assert only that it equals
    # itself, while this fails the moment someone hardcodes prevention back on and leaves the
    # binding behind, which is precisely how half of this fix could be undone without a red test.
    #
    # The other half we cannot check from here and so must explain: most enterprise organizations
    # set `constraints/iam.allowedPolicyMemberDomains`, which blocks `allUsers` in every policy in
    # the org regardless of this bucket's settings.
    precondition {
      condition     = google_storage_bucket.this[each.key].public_access_prevention != "enforced"
      error_message = <<-EOT
        Bucket "${each.key}" asks for public access, but public_access_prevention is "enforced" —
        Cloud Storage will reject the allUsers binding. These two settings are one feature and must
        move together.

        Note that even with prevention set to "inherited" this grant is refused if the organization
        policy constraints/iam.allowedPolicyMemberDomains is in force, which is the default posture
        in most enterprise GCP organizations. Public buckets are not available under that policy.
      EOT
    }
  }
}
