# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "bucket_names" {
  description = "Names of the created OSS buckets"
  value       = [for b in alicloud_oss_bucket.this : b.bucket]
}

output "bucket_domains" {
  description = "Map of bucket name to its intranet endpoint"
  value       = { for k, b in alicloud_oss_bucket.this : k => b.intranet_endpoint }
}
