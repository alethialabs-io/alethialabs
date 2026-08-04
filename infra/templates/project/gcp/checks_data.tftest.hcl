# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# checks_data.tf's keyless Cloud SQL identity check, pinned from BOTH sides (#1920).
#
# The defect: the check indexed `module.cloud_sql[0]`, and that module is COUNTED. Every gcp project
# that does not provision Cloud SQL therefore made it an empty tuple, and the index is an EVALUATION
# ERROR rather than a false term:
#
#   Error: Invalid index
#     on checks_data.tf line 20, in check "keyless_cloud_sql_app_identity_wired":
#     20:     condition = !local.app_db_iam_requested || (… && module.cloud_sql[0].app_iam_user != null)
#       ├────────────────
#       │ module.cloud_sql is empty tuple
#
# It killed `tofu plan` outright — before any resource was created — for the gcp leg of the T2
# real-cloud nightly (run 30882660761), on a project whose Cloud SQL switch was simply OFF.
#
# WHY NO TEST CAUGHT IT, and the thing to know before trusting this file: whether HCL short-circuits
# `||` is OPENTOFU-VERSION-DEPENDENT. >= 1.10 stops at a known-true left operand and never touches
# the index; 1.9.x evaluates both operands and collects the diagnostics of each. The runner
# provisions with 1.9.0 (packages/core/tofu.DefaultIaCVersion, pinned by packages/core/compat/
# matrix.json) while .github/workflows/infra-templates.yml runs this suite at 1.10.10. So the FIRST
# run below — the regression case — is a hard `Invalid index` failure on the unfixed template under
# 1.9.0 and a silent pass under 1.10.10. Verified by running the suite under both. It is kept anyway
# because it pins the SHAPE: with a splat instead of an index the off-case is degenerate-safe at
# every version, which is the only property that is actually version-independent.
#
# The second run is the half that matters for the fix itself. `one([])` is null, and the easy way to
# make an empty tuple safe is to make the whole term null-tolerant — which would also make it stop
# reporting a REAL half-built identity. So the on-case asserts the check still FAILS.
#
# KNOWN, and OUT OF SCOPE for #1920: the two Cloud-SQL-ON runs below are green at 1.10.10 but red at
# 1.9.0, and not because of anything in checks_data.tf. modules/cloud-sql/checks.tf lines 64 and 93
# carry the SAME class of defect — `!(engine == "MYSQL" && app_iam_sa_email != null) || (length(
# local.app_iam_user) …)`, where `local.app_iam_user` is null whenever no app GSA was passed. Under
# 1.9.0 the right operand is evaluated regardless and the plan dies with "argument must not be
# null", on BOTH engines, for every gcp project that provisions Cloud SQL without a keyless
# identity. The second of the two is an apply-blocking `precondition`, not a check. Its own comment
# (lines 52-60) records the same hazard being fixed once for the error_message and missed for the
# condition. Filed separately; fixing it here would edit a module another lane owns.
#
# This file is at the ROOT on purpose: `modules/**/*.tftest.hcl` is silently never executed.

mock_provider "google" {
  # The VPC self_link flows into google_sql_database_instance.settings.ip_configuration
  # .private_network, which the provider parses against a strict regexp before any API call. Not
  # under test — it must merely parse. Same reason as checks_cluster_optional.tftest.hcl.
  mock_resource "google_compute_network" {
    defaults = {
      self_link = "https://www.googleapis.com/compute/v1/projects/mock-project/global/networks/mock-vpc"
      id        = "projects/mock-project/global/networks/mock-vpc"
    }
  }
}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  project_id   = "mock-project"
  region       = "europe-west3"
  environment  = "production"
  project_name = "alethia-nl"

  # No cluster anywhere in this file. `provision_gke = true` is NOT PLANNABLE UNDER MOCKS on GCP at
  # all — modules/gke/outputs.tf reads google_container_cluster.master_auth[0], a computed-only BLOCK
  # that a mock leaves empty and that `mock_resource` refuses to override. The long note at the foot
  # of checks_cluster_optional.tftest.hcl records that as a documented gap.
  provision_gke = false

  # The subject. Each run sets exactly what it is testing.
  create_cloud_sql   = false
  cloud_sql_iam_auth = false
}

# THE REGRESSION. A project with the Cloud SQL switch OFF must PLAN, and must warn about nothing:
# nobody asked for keyless anything, so `local.app_db_iam_requested` is false and the check has no
# opinion. On the unfixed template this run does not fail an assertion — it dies evaluating the
# check, which is why the nightly's error arrived as a plan failure and not as a check warning.
run "cloud_sql_off_plans_without_indexing_an_empty_module" {
  command = plan

  assert {
    condition     = length(module.cloud_sql) == 0
    error_message = "create_cloud_sql = false must produce no Cloud SQL module instance — the zero-length tuple this check has to survive."
  }

  # Named so that deleting the check stops this file parsing rather than passing it.
  assert {
    condition     = length(google_service_account.app_db) == 0
    error_message = "No Cloud SQL and no IAM auth means no keyless app identity."
  }
}

# Cloud SQL ON with IAM auth requested but the identity INCOMPLETE — there is no cluster, so no app
# GSA is created and cloud-sql.tf registers no CLOUD_IAM_SERVICE_ACCOUNT user. The check must still
# say so. Without this run, "fix" the empty tuple by making the term null-tolerant everywhere and the
# warning goes silent on a genuinely half-built keyless database, which is the actual risk here.
run "cloud_sql_on_with_an_incomplete_identity_still_trips_the_check" {
  command = plan

  variables {
    create_cloud_sql   = true
    cloud_sql_iam_auth = true
  }

  assert {
    condition     = length(module.cloud_sql) == 1
    error_message = "Cloud SQL is independent of the cluster and must still be created — otherwise this run proves nothing about the on-case."
  }

  assert {
    condition     = one(module.cloud_sql[*].app_iam_user) == null
    error_message = "With no cluster there is no app GSA, so the module must register no CLOUD_IAM_SERVICE_ACCOUNT login — this is the incompleteness the check exists to report."
  }

  expect_failures = [check.keyless_cloud_sql_app_identity_wired]
}

# The third corner: Cloud SQL ON, IAM auth OFF. A plain password database is not a keyless request,
# so the check must stay SILENT even though `module.cloud_sql` is non-empty and its `app_iam_user`
# output is null. Pinned because a fix that keyed on "is the module present" rather than on what the
# operator asked for would fire here, and a guard that fires on every ordinary database is one people
# learn to ignore.
run "cloud_sql_on_without_iam_auth_warns_about_nothing" {
  command = plan

  variables {
    create_cloud_sql   = true
    cloud_sql_iam_auth = false
  }

  assert {
    condition     = length(module.cloud_sql) == 1 && one(module.cloud_sql[*].app_iam_user) == null
    error_message = "A password-auth Cloud SQL instance must be created with no IAM login attached."
  }
}
