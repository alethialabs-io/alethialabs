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

  # Same construction argument, carried through the `-logs` suffix: 5 more characters on a name
  # that is at most 58 (the derived form caps at 49, and var.state_bucket_name is validated to 58
  # PRECISELY so this stays provable), so at most 63. Still no runtime check needed.
  #
  # UNCONDITIONALLY DERIVED, with no override variable of its own. The sink's name has to stay
  # readable as "the log bucket for THAT state bucket", and an escape hatch already exists one
  # level up: if `<name>-logs` is taken, set `state_bucket_name` and both names move together. An
  # `""`-defaulted override here would also be exactly the empty-default-steers-a-branch shape
  # `scripts/check-tfvars-safety.mjs` ratchets down (#3108).
  state_log_bucket_name = "${local.state_bucket_name}-logs"
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

  # Access logging (#4903). Versioning answers "can I get the old state back"; this answers "who
  # read or wrote it", which is the other half of the question a state bucket has to be able to
  # answer — it holds project role bindings and a WIF provider's configuration.
  #
  # GCS usage logs are delivered by the service on a ~1h cadence, NOT synchronously with the
  # request, so this is a forensic record and never a real-time alarm. Nothing in this repo reads
  # it; you read it after you have a reason to.
  logging {
    log_bucket        = google_storage_bucket.tofu_state_logs.name
    log_object_prefix = "gcp-e2e-state"
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

# ── The access-log sink (#4903) ───────────────────────────────────────────────────────────────
#
# SEPARATE BUCKET, NOT SELF-LOGGING. GCS will happily deliver a bucket's usage logs into that same
# bucket, and it would have been one fewer resource. Three reasons it is wrong here:
#
#   1. CIRCULARITY. Every log delivery is itself a write to the bucket, which is logged, which is
#      a write. GCS does not loop forever on this, but the log stream stops being a record of
#      state access and becomes mostly a record of itself.
#   2. THE STATE BUCKET IS MEANT TO BE BORING. `docs/testing/e2e-state-migration.md` has the
#      operator run `gcloud storage ls "gs://<bucket>/**"` and expects EXACTLY two objects. Hourly
#      log shards would bury that check, and the state bucket's lifecycle rule above is written in
#      `num_newer_versions` — tuned for generations of one object, not for an append-only log.
#   3. INTEGRITY. Whoever can write state could otherwise rewrite the record of their having done
#      so. Splitting the sink does not make that impossible — the same admin identity applies both
#      — but it stops it being a side effect of ordinary state access.
#
# THIS BUCKET MUST NOT LOG TO ITSELF, and it has no `logging` block for that reason: a sink that
# logs its own deliveries generates writes forever from one write. There is no third bucket either;
# the chain terminates here, on purpose.
resource "google_storage_bucket" "tofu_state_logs" {
  name     = local.state_log_bucket_name
  project  = var.project_id
  location = var.location

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # No versioning. Usage log shards are written once and never updated, so versioning would buy
  # nothing and bill for a second copy of everything.

  # Age-based expiry, not `num_newer_versions`: this bucket's growth is in OBJECTS over time, not
  # in generations of one object.
  lifecycle_rule {
    condition {
      age = var.access_log_retention_days
    }
    action {
      type = "Delete"
    }
  }

  force_destroy = false

  labels = local.labels

  # Same reasoning as the state bucket, one step removed: an audit trail that one command can
  # delete is not an audit trail. The lifecycle rule above is what keeps it from growing without
  # bound, so nothing needs to destroy this bucket to control it.
  lifecycle {
    prevent_destroy = true
  }
}

# GCS delivers usage logs as the group `cloud-storage-analytics@google.com`, which must hold write
# access on the sink or delivery silently does not happen — no error surfaces on the source bucket.
# `roles/storage.legacyBucketWriter` is the documented grant, and an IAM binding rather than an ACL
# is the only spelling available: the sink has uniform bucket-level access, which disables ACLs.
resource "google_storage_bucket_iam_member" "log_writer" {
  bucket = google_storage_bucket.tofu_state_logs.name
  role   = "roles/storage.legacyBucketWriter"
  member = "group:cloud-storage-analytics@google.com"
}
