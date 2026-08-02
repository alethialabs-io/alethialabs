# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cloud SQL data-tier invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

# Keyless Cloud SQL auth (#722): when IAM auth is on, the app must have a Workload-Identity path to
# the DB — the app GSA + its CLOUD_IAM_SERVICE_ACCOUNT database user + the GKE cluster it federates
# through. Assert they're all wired so a keyless binding can't render pointed at a login that never
# got created (which would fail closed at deploy, but louder to catch here at plan time).
#
# Keyed on `app_db_iam_requested`, NOT `enable_app_db_iam`: the build predicate gained
# `var.provision_gke` in the #1772 parity pass, and keying on it would make this check judge its own
# definition — `!enable || provision_gke` is trivially true once `enable` contains `provision_gke` —
# silencing the one warning that tells an operator their keyless Cloud SQL has no cluster to be
# keyless FROM. The `var.provision_gke &&` term inside is unchanged and is now what does the work.
check "keyless_cloud_sql_app_identity_wired" {
  assert {
    condition     = !local.app_db_iam_requested || (var.provision_gke && length(google_service_account.app_db) == 1 && module.cloud_sql[0].app_iam_user != null)
    error_message = "cloud_sql_iam_auth is on but the keyless app identity is incomplete: it needs provision_gke=true, the app GSA, and the CLOUD_IAM_SERVICE_ACCOUNT database user."
  }
}
