# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# External-secrets identity invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

# The external-secrets GSA must exist whenever GKE is provisioned — without it the gcpsm
# ClusterSecretStore is (correctly) not rendered and ExternalSecrets can never sync.
check "external_secrets_gsa_present" {
  assert {
    condition     = !var.provision_gke || length(trimspace(try(google_service_account.external_secrets[0].email, ""))) > 0
    error_message = "provision_gke is true but the external-secrets Google service account reported no email — the ESO ClusterSecretStore cannot authenticate."
  }
}

# The external-secrets identity must be exactly one of "created here" or "adopted" — never both and
# never neither. If this ever resolved empty, every secretAccessor grant below would render
# `serviceAccount:` with no principal and the apply would fail deep inside IAM with an opaque error
# instead of here, at plan time, saying which input was wrong.
check "external_secrets_identity_resolved" {
  assert {
    condition     = !var.provision_gke || local.external_secrets_sa_email != ""
    error_message = "The external-secrets service account resolved to an empty email — set external_secrets_service_account_email to adopt a pre-existing GSA, or leave it empty to have this template create one."
  }
}

# Adoption must not silently co-exist with a created GSA: exactly one of the two must be present.
check "external_secrets_identity_single_owner" {
  assert {
    condition     = !var.provision_gke || (local.external_secrets_adopted != (length(google_service_account.external_secrets) > 0))
    error_message = "The external-secrets GSA must be either adopted or created by this template, never both — check external_secrets_service_account_email."
  }
}
