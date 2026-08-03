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

# Reports the encryption algorithm as PLANNED ON THE RESOURCE, not as passed in — reading it back off
# alicloud_oss_bucket is what makes checks_oss.tftest.hcl a test of the wiring rather than a test of
# its own input. "None" is the honest answer for a bucket with no rule: OSS itself reports that state
# as 400 NoSuchServerSideEncryptionRule, and it means the objects are stored unencrypted.
output "bucket_encryption" {
  description = "Map of bucket name suffix to the server-side encryption algorithm on the bucket (\"None\" when no rule is set)"
  value = {
    for k, b in alicloud_oss_bucket.this :
    k => length(b.server_side_encryption_rule) > 0 ? b.server_side_encryption_rule[0].sse_algorithm : "None"
  }
}
