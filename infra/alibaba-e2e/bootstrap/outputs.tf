# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "state_bucket" {
  description = "The OSS bucket holding the alibaba-e2e stacks' OpenTofu state. Put this in both backend.hcl files (this stack's and the parent's)."
  value       = alicloud_oss_bucket.tofu_state.bucket
}

output "state_bucket_region" {
  description = "The region the state bucket lives in. backend.hcl's `region` MUST match it — the OSS backend derives its endpoint from that value."
  value       = var.region
}
