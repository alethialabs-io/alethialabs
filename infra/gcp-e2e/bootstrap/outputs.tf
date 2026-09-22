# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "state_bucket" {
  description = "The GCS bucket holding the gcp-e2e stacks' OpenTofu state. Put this in both backend.hcl files (this stack's and the parent's)."
  value       = google_storage_bucket.tofu_state.name
}

output "state_bucket_url" {
  description = "gs:// URL of the state bucket — use it to list generations when verifying a migration."
  value       = google_storage_bucket.tofu_state.url
}

output "state_log_bucket" {
  description = "The GCS bucket receiving the state bucket's usage logs (#4903). Not a backend target — nothing puts state here. Read it with `gcloud storage ls gs://<this>/` when you need to know who touched state."
  value       = google_storage_bucket.tofu_state_logs.name
}
