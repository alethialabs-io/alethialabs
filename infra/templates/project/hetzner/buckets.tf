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
#   * CORS  — the aminueza/minio provider does not support CORS against a non-MinIO backend
#             (s3_compat_mode skips it), so var.buckets[*].cors_origins is IGNORED on Hetzner.
#   * Encryption — Hetzner Object Storage encrypts at rest automatically; there is no
#             per-bucket toggle, so encryption_enabled is informational only.

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
