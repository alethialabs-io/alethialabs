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
#
# `one(module.cloud_sql[*].app_iam_user)`, NEVER `module.cloud_sql[0].app_iam_user` (#1920). The
# module is COUNTED, so on every project that does not provision Cloud SQL it is a ZERO-LENGTH TUPLE
# and the index is an evaluation error, not a false term:
#
#   Error: Invalid index … module.cloud_sql is empty tuple
#
# The `!local.app_db_iam_requested ||` guard does not save it, because whether HCL short-circuits a
# logical operator is VERSION-DEPENDENT: OpenTofu >= 1.10 stops at a known-true left operand, 1.9.x
# evaluates both sides and collects the diagnostics from each. The runner provisions with 1.9.0
# (packages/core/tofu.DefaultIaCVersion, pinned by compat matrix.json) while this template's CI runs
# 1.10.10 — so the index planned clean in CI and killed `tofu plan` for every gcp project in the T2
# nightly (run 30882660761), before a single resource was created. A splat is degenerate-safe on an
# empty tuple where an index is not: `one([])` is null, and null != null is a plain false, so the
# check still SPEAKS on a Cloud SQL that is on with an incomplete identity. Do not reintroduce an
# index here, and do not "fix" it by adding a fourth guard term — a guard term is only as good as
# the evaluation semantics of the tofu that reads it.
check "keyless_cloud_sql_app_identity_wired" {
  assert {
    condition     = !local.app_db_iam_requested || (var.provision_gke && length(google_service_account.app_db) == 1 && one(module.cloud_sql[*].app_iam_user) != null)
    error_message = "cloud_sql_iam_auth is on but the keyless app identity is incomplete: it needs provision_gke=true, the app GSA, and the CLOUD_IAM_SERVICE_ACCOUNT database user."
  }
}
