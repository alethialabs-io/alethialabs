# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# Hetzner Object Storage (S3-compatible) buckets.
#
# Hetzner Object Storage is a separate product from the Hetzner Cloud API: it speaks the
# S3 API at https://<location>.your-objectstorage.com and authenticates with an S3
# access-key/secret-key pair the customer generates by hand in the Hetzner Console
# (there is no API to mint them). We drive it with the Hetzner-docs-endorsed aminueza/minio
# provider in S3-compatibility mode.
#
# Activation is lazy: the minio provider is always declared, but every resource here uses
# `for_each` over var.buckets, so an empty list means the provider is never exercised — a
# Hetzner cluster that provisions no buckets plans clean even with empty S3 credentials.
#
# Feature notes (honest gating — never a failure):
#   * CORS  — wired to minio_s3_bucket_cors by #4320, with a limitation. The rule is only built for
#             a bucket that ASKS for one, and `s3_compat_mode = true` below makes the provider skip
#             the call rather than fail it if Hetzner's backend does not implement it — CORS is one
#             of the four features aminueza/minio names as gracefully skipped in that mode
#             (notifications, CORS, object lock, lifecycle). So asking for CORS here is either
#             honoured or a no-op; it is never an apply error, and it is no longer silently dropped
#             before it reaches a resource.
#   * Encryption — not a knob at all (DELETED by #4320): Hetzner Object Storage supports exactly
#             one encryption type, SSE-C (per-request, customer-supplied keys), per Hetzner's own
#             supported-actions matrix. There is no bucket-level default-encryption configuration
#             for a resource to write, so minio_s3_bucket_server_side_encryption — which only offers
#             AES256 (SSE-S3) and aws:kms — has nothing it could set. Objects are encrypted at rest
#             regardless. See var.buckets in variables.tf.

provider "minio" {
  # minio_server is the S3 endpoint HOST (no scheme); minio_ssl toggles https.
  minio_server   = var.hetzner_s3_endpoint
  minio_region   = var.hetzner_s3_region
  minio_user     = var.hetzner_s3_access_key
  minio_password = var.hetzner_s3_secret_key
  minio_ssl      = true

  # Gracefully skip features Hetzner's S3 backend returns "Not Implemented" for (CORS,
  # object-lock, notifications, lifecycle) instead of erroring the apply.
  s3_compat_mode = true
}

locals {
  # Keyed by bucket name for a stable for_each. The full bucket name is namespaced by
  # cluster so multiple projects/environments don't collide in Hetzner's flat S3 namespace.
  buckets_by_name = { for b in var.buckets : b.name => b }
}

# One bucket per entry. acl maps public_access -> a canned ACL; force_destroy lets a
# `tofu destroy` clean up non-empty buckets (Alethia owns the lifecycle).
resource "minio_s3_bucket" "bucket" {
  for_each = local.buckets_by_name

  bucket        = "${local.cluster_name}-${each.value.name}"
  acl           = each.value.public_access ? "public-read" : "private"
  force_destroy = true
}

# Versioning is a separate resource in the minio provider (and IS supported by Hetzner
# Object Storage). Only created for buckets that request it.
resource "minio_s3_bucket_versioning" "bucket" {
  for_each = { for name, b in local.buckets_by_name : name => b if b.versioning }

  bucket = minio_s3_bucket.bucket[each.key].bucket

  versioning_configuration {
    status = "Enabled"
  }
}

# CORS (#4320). `cors_origins` was declared on the bucket object, carried from the console, and read
# by no resource — the knob-exclusions ledger's `dead:` shape, and the template's own header used to
# say so rather than fix it.
#
# Only created for a bucket that asks: the provider's cors_rule block has min_items = 1, so an empty
# origin list has no legal rule to write, and a bucket with no CORS request must get no resource at
# all rather than an empty one.
#
# Methods are the read/write set a browser can use against an object; they are not offered per
# bucket because nothing upstream collects them, and inventing a narrower set would mean a caller
# who asks for CORS gets a rule that blocks the request they asked to allow. `max_age_seconds` is
# left unset so the browser applies its own default.
resource "minio_s3_bucket_cors" "bucket" {
  for_each = { for name, b in local.buckets_by_name : name => b if length(b.cors_origins) > 0 }

  bucket = minio_s3_bucket.bucket[each.key].bucket

  cors_rule {
    allowed_origins = each.value.cors_origins
    allowed_methods = ["GET", "HEAD", "PUT", "POST", "DELETE"]
    allowed_headers = ["*"]
  }
}
