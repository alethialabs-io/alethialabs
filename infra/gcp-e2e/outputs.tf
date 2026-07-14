# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "e2e_gcp_wif_provider" {
  description = "Full WIF provider resource name. Set as the repo Actions VARIABLE E2E_GCP_WIF_PROVIDER — google-github-actions/auth uses it as `workload_identity_provider` to enable the GCP T2 nightly (e2e-nightly.yml gates on it)."
  value       = google_iam_workload_identity_pool_provider.e2e.name
}

output "e2e_gcp_sa_email" {
  description = "The e2e provisioner service account email. Set as the repo Actions VARIABLE E2E_GCP_SA_EMAIL (auth `service_account`). NOTE: the workflow reads it from vars.E2E_GCP_SERVICE_ACCOUNT — set BOTH the E2E_GCP_WIF_PROVIDER gate var and the SA var."
  value       = google_service_account.e2e.email
}

output "e2e_gcp_budget_topic" {
  description = "Pub/Sub topic the e2e GCP Budget alerts publish to (hang a kill-switch here later)."
  value       = google_pubsub_topic.e2e_budget.id
}

output "e2e_gcp_project_number" {
  description = "The dedicated e2e project's number (the budget filter + WIF principal anchor)."
  value       = data.google_project.this.number
}
