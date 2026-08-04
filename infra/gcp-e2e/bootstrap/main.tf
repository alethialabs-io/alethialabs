# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Bootstrap for infra/gcp-e2e: the GCS bucket that holds its OpenTofu state.
#
# WHY THIS IS A SEPARATE STACK. A stack cannot hold its own state in a bucket it has not created
# yet, and infra/gcp-e2e owns real, hard-to-recreate identity (a WIF pool + provider, the
# provisioner SA and its project role bindings, a Pub/Sub topic, a billing budget). Losing that
# state means importing every one of them back by hand. So the container is broken out into a
# one-resource stack applied first — the same shape `infra/email-ses/bootstrap` uses for the AWS
# side, which is why `infra/aws-oidc` has had a remote backend all along.
#
# This stack's OWN state goes into the bucket it creates, via one documented two-phase init
# (`-backend=false` → apply → `-migrate-state`). The recursion terminates there; see
# docs/testing/e2e-state-migration.md.

locals {
  labels = {
    project = "alethia"
    role    = "gcp-e2e-bootstrap"
    managed = "opentofu"
  }

  # Derived by CONSTRUCTION, not asserted after the fact. The prefix is 19 characters and
  # var.project_id is validated to GCP's own 6-30 cap, so the result is 25-49 characters — inside
  # the 63-character GCS bucket-name cap for every legal project id, with no runtime check needed.
  state_bucket_name = var.state_bucket_name != "" ? var.state_bucket_name : "alethia-tofu-state-${var.project_id}"
}

# The state bucket. Versioning is the durability property that matters: each apply writes a new
# generation, so a truncated write or an accidental delete is recoverable to the previous one.
resource "google_storage_bucket" "tofu_state" {
  name     = local.state_bucket_name
  project  = var.project_id
  location = var.location

  # Uniform IAM only — no per-object ACLs to reason about — and no path by which state can be
  # made public.
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  # A `tofu destroy` here must never be able to take the state with it. `force_destroy = false`
  # makes the API refuse while objects remain; `prevent_destroy` stops the plan being generated at
  # all. Both, deliberately: they fail at different moments.
  force_destroy = false

  lifecycle_rule {
    condition {
      num_newer_versions = var.noncurrent_state_versions_kept
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  labels = local.labels

  lifecycle {
    prevent_destroy = true
  }
}
