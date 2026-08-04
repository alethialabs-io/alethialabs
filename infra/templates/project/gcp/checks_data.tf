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
# The `try()` is NOT decoration, and the note on alibaba/checks_secrets.tf that called the same
# `try()` "belt-and-braces" was measured on the wrong OpenTofu. `||` short-circuiting is
# VERSION-DEPENDENT, and it is absent in the version this product ships:
#
#   fixture: !requested || (gke && length(res) == 1 && module.cloud_sql[0].out != null), no cloud_sql
#   1.9.0   (apps/runner/Dockerfile.base TOFU_VERSION, compat matrix `tofu`) → Invalid index, PLAN DIES
#   1.10.10 (what infra-templates.yml used to gate this file with)          → plans clean
#   1.12.3                                                                  → plans clean
#
# Without the `try()` this check made the ENTIRE gcp template unplannable on 1.9.0 for every project
# that has no Cloud SQL — which is the shape the nightly sends, and is how #1920 took the gcp leg
# down at `planning` before it reached apply.
#
# The guard that should have caught this ALREADY EXISTS and already fails: run
# `clusterless_still_plans_with_every_cluster_identity_requested` in checks_cluster_optional.tftest.hcl
# plans exactly this shape, and on 1.9.0 every one of the seven gcp suites died here. It is run on a
# version where it cannot fail — infra-templates.yml pins TOFU_VERSION 1.10.10 while the runner
# applies 1.9.0. That skew is its own defect (it also hides two live azure ones) and is tracked
# separately; do not read the green template gate as proof this file plans.
#
# `length(trimspace(...)) > 0` rather than `!= null` matches the sibling checks on aws and alibaba,
# and means a genuinely renamed module output still fails the check loudly instead of being
# swallowed by the `try()`.
#
# The `try()` wraps `trimspace(...)`, not just the index, because eager evaluation reaches TWO
# different errors depending on the shape: `create_cloud_sql = false` gives "Invalid index" on the
# empty tuple, and `create_cloud_sql = true, provision_gke = false` gives "argument must not be
# null" from `trimspace` — the module is there, but its `app_iam_user` is null because no app GSA
# was built. A `try()` around the index alone catches only the first.
check "keyless_cloud_sql_app_identity_wired" {
  assert {
    condition     = !local.app_db_iam_requested || (var.provision_gke && length(google_service_account.app_db) == 1 && length(try(trimspace(module.cloud_sql[0].app_iam_user), "")) > 0)
    error_message = "cloud_sql_iam_auth is on but the keyless app identity is incomplete: it needs provision_gke=true, the app GSA, and the CLOUD_IAM_SERVICE_ACCOUNT database user."
  }
}
