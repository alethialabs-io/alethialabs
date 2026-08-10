# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# These become repo VARIABLES the nightly passes to the e2e. None is a secret: a project id, a
# secret name and a digest. The canary VALUE never appears here — only its sha256, which is what the
# in-cluster read is compared against. See docs/testing/e2e-nightly-enablement.md.

output "target_project_id" {
  description = "ALETHIA_E2E_SECRETS_XACCT_PROJECT_ID — the project the connector reads from."
  value       = var.target_project_id
}

output "remote_key" {
  description = "ALETHIA_E2E_SECRETS_XACCT_REMOTE_KEY — the secret the workload reads across the boundary."
  value       = google_secret_manager_secret.canary.secret_id
}

output "expect_sha256" {
  description = "ALETHIA_E2E_SECRETS_XACCT_EXPECT_SHA256 — sha256 of the canary value. The e2e compares the READ value's digest against this, so the value itself never has to travel or be stored."
  # nonsensitive() is deliberate and is the whole design, mirroring the AWS sibling: the digest
  # inherits canary_value's sensitive marking, but a sha256 is not a secret — it is precisely what
  # lets the expectation travel to CI while the value itself never leaves this stack.
  value = nonsensitive(sha256(var.canary_value))
}

output "granted_service_account" {
  description = "The standing GSA that was granted secretAccessor. Must equal the project template's external_secrets_service_account_email, or the cluster reads as a different identity and is denied."
  value       = var.cluster_external_secrets_sa
}
