# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Bootstrap for infra/alibaba-e2e: the OSS bucket that holds its OpenTofu state.
#
# WHY THIS IS A SEPARATE STACK. A stack cannot hold its own state in a bucket it has not created
# yet, and infra/alibaba-e2e owns a RAM OIDC provider, the `alethia-e2e-nightly` role and its
# least-privilege policy — identity that has to be rebuilt by hand if the state is lost. So the
# container is broken out into a one-resource stack applied first, mirroring
# `infra/email-ses/bootstrap` on the AWS side.
#
# This stack's OWN state goes into the bucket it creates, via one documented two-phase init
# (`-backend=false` → apply → `-migrate-state`). Runbook: docs/testing/e2e-state-migration.md.

locals {
  tags = {
    project = "alethia"
    role    = "alibaba-e2e-bootstrap"
    managed = "opentofu"
  }

  # `-logs` is 5 characters and var.state_bucket_name is validated to 58 PRECISELY so this stays
  # inside OSS's 63-character cap by construction, with no runtime check needed.
  #
  # UNCONDITIONALLY DERIVED, with no override variable of its own. The sink's name has to stay
  # readable as "the log bucket for THAT state bucket", and an escape hatch already exists one
  # level up: if `<name>-logs` is taken, set `state_bucket_name` and both names move together. An
  # `""`-defaulted override here would also be exactly the empty-default-steers-a-branch shape
  # `scripts/check-tfvars-safety.mjs` ratchets down (#3108).
  state_log_bucket_name = "${var.state_bucket_name}-logs"
}

# The state bucket. Versioning is the durability property that matters: each apply writes a new
# version, so a truncated write or an accidental delete is recoverable to the previous one.
resource "alicloud_oss_bucket" "tofu_state" {
  bucket        = var.state_bucket_name
  storage_class = "Standard"

  # A `tofu destroy` here must never be able to take the state with it. `force_destroy = false`
  # makes the API refuse while objects remain; the `prevent_destroy` below stops the plan being
  # generated at all. Both, deliberately: they fail at different moments.
  force_destroy = false

  versioning {
    status = "Enabled"
  }

  server_side_encryption_rule {
    sse_algorithm = "AES256"
  }

  tags = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

# Private ACL, stated rather than inherited. `alicloud_oss_bucket.acl` was deprecated in provider
# 1.220 in favour of this resource, and the pin here is >= 1.240 — so the separate resource is the
# only non-deprecated spelling available to us.
resource "alicloud_oss_bucket_acl" "tofu_state" {
  bucket = alicloud_oss_bucket.tofu_state.bucket
  acl    = "private"
}

# Belt to the private-ACL braces: refuse public access at the bucket level regardless of any ACL or
# policy set later, by hand or otherwise.
resource "alicloud_oss_bucket_public_access_block" "tofu_state" {
  bucket              = alicloud_oss_bucket.tofu_state.bucket
  block_public_access = true
}

# ── The access-log sink (#4903) ───────────────────────────────────────────────────────────────
#
# Versioning answers "can I get the old state back"; access logging answers "who read or wrote it".
# For a bucket holding a RAM OIDC provider's trust configuration and a role's policy, the second
# question is the one an incident asks.
#
# SEPARATE BUCKET, NOT SELF-LOGGING. OSS lets a bucket be its own logging target, and it would have
# been one fewer resource. Three reasons it is wrong here:
#
#   1. CIRCULARITY. Every log delivery is itself a write to the bucket, which is logged, which is
#      a write. The log stream stops being a record of state access and becomes mostly a record of
#      itself.
#   2. THE STATE BUCKET IS MEANT TO BE BORING. `docs/testing/e2e-state-migration.md` has the
#      operator run `aliyun oss ls ... --recursive` and expects EXACTLY two objects. Hourly log
#      shards would bury that check.
#   3. INTEGRITY. Whoever can write state could otherwise rewrite the record of their having done
#      so.
#
# It must be in the SAME REGION as the source bucket — OSS refuses a cross-region logging target —
# which it is, both being created by this provider instance.
#
# THIS BUCKET MUST NOT LOG TO ITSELF, and it has no logging rule for that reason: a sink that logs
# its own deliveries generates writes forever from one write. The chain terminates here.
resource "alicloud_oss_bucket" "tofu_state_logs" {
  bucket        = local.state_log_bucket_name
  storage_class = "Standard"

  force_destroy = false

  # No versioning. Log shards are written once and never updated, so versioning would buy nothing
  # and bill for a second copy of everything.

  server_side_encryption_rule {
    sse_algorithm = "AES256"
  }

  # Age-based expiry. The sink grows in OBJECTS over time, so this is what keeps it bounded — and
  # it is why `prevent_destroy` below costs nothing.
  lifecycle_rule {
    id      = "expire-access-logs"
    prefix  = ""
    enabled = true

    expiration {
      days = var.access_log_retention_days
    }
  }

  tags = local.tags

  # Same reasoning as the state bucket, one step removed: an audit trail that one command can
  # delete is not an audit trail.
  lifecycle {
    prevent_destroy = true
  }
}

resource "alicloud_oss_bucket_acl" "tofu_state_logs" {
  bucket = alicloud_oss_bucket.tofu_state_logs.bucket
  acl    = "private"
}

resource "alicloud_oss_bucket_public_access_block" "tofu_state_logs" {
  bucket              = alicloud_oss_bucket.tofu_state_logs.bucket
  block_public_access = true
}

# The logging rule itself. OSS's own service account writes the shards; unlike GCS this needs no
# grant on the target, only that the target exists and shares the source's region and owner.
resource "alicloud_oss_bucket_logging" "tofu_state" {
  bucket        = alicloud_oss_bucket.tofu_state.bucket
  target_bucket = alicloud_oss_bucket.tofu_state_logs.bucket
  target_prefix = "alibaba-e2e-state/"
}
