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
