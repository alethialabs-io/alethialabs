# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof for the keyless Cloud SQL app identity being ADOPTED rather than created.
#
# Why the shape changed: `roles/cloudsql.client` and `roles/cloudsql.instanceUser` are project-scoped
# only — a Cloud SQL instance is not IAM-policy-bearing, so there is no
# google_sql_database_instance_iam_member to scope them to. Writing a project binding needs
# resourcemanager.projects.setIamPolicy, which the provisioner deliberately does not hold, so the two
# google_project_iam_member resources #722 added here 403'd on every apply. The grant moved to the
# customer's connector bootstrap and the account is adopted through
# var.cloud_sql_app_service_account_email.
#
# What this file pins is the OPT-IN CONTRACT: the variable is what decides whether keyless is wired,
# and an unset variable must leave a working password-auth project rather than a half-built one.
#
# Providers are mocked and the cluster stays off, so this needs no credentials.

mock_provider "google" {
  # Cloud SQL's private_network reads the VPC self_link and the provider parses it against a strict
  # regexp before any API call. Not under test — it must merely parse. Same reason as
  # checks_cluster_optional.tftest.hcl.
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

  # The database is the subject; everything cluster-scoped is off. See the DOCUMENTED GAP at the
  # foot of this file for why the cluster cannot be turned on.
  provision_gke    = false
  create_cloud_sql = true

  provision_artifact_registry = false
  create_memorystore          = false
  create_memorystore_valkey   = false
  create_pubsub               = false
  create_firestore            = false
  create_cloud_storage        = false
  cloud_dns_enabled           = false
  cloud_armor_enabled         = false
}

################################################################################
# 1. The variable is a full SA email or nothing
################################################################################
#
# The bare account id is the mistake worth catching: `alethia-appdb` looks right in the console and
# would render `serviceAccount:alethia-appdb` into a Workload Identity binding that resolves to no
# principal. Failing in `validation` puts the error on the input the operator typed.

run "a_bare_account_id_is_refused" {
  command = plan

  variables {
    cloud_sql_iam_auth                  = true
    cloud_sql_app_service_account_email = "alethia-appdb"
  }

  expect_failures = [var.cloud_sql_app_service_account_email]
}

run "an_email_from_the_wrong_domain_is_refused" {
  command = plan

  variables {
    cloud_sql_iam_auth                  = true
    cloud_sql_app_service_account_email = "alethia-appdb@example.com"
  }

  expect_failures = [var.cloud_sql_app_service_account_email]
}

run "a_full_service_account_email_is_accepted" {
  command = plan

  variables {
    cloud_sql_iam_auth                  = true
    cloud_sql_app_service_account_email = "alethia-appdb@mock-project.iam.gserviceaccount.com"
  }

  assert {
    condition     = length(module.cloud_sql) == 1
    error_message = "A valid adoption email must not block the plan."
  }

  # The account is well-formed but this shape has no cluster, so keyless still is not wired and the
  # warning still fires. Named here rather than silenced: it is the SECOND half of the predicate
  # (`provision_gke`) speaking, and a run that hid it would also hide the variable doing nothing.
  expect_failures = [check.keyless_cloud_sql_app_identity_wired]
}

################################################################################
# 2. The OPT-IN gate — an unset variable leaves a WORKING project, not a broken one
################################################################################
#
# This is the regression that matters. Before adoption, `cloud_sql_iam_auth = true` unconditionally
# built an identity and tried to grant it project roles, which 403'd and took the whole apply with
# it. The fallback contract is that the database is still built and the app keeps the BUILT_IN
# password user — so keyless being unavailable costs a warning, never the deployment.

run "iam_auth_without_an_adopted_account_still_builds_the_database" {
  command = plan

  variables {
    cloud_sql_iam_auth = true
    # cloud_sql_app_service_account_email deliberately left at its "" default.
  }

  assert {
    condition     = length(module.cloud_sql) == 1
    error_message = "cloud_sql_iam_auth with no adopted account must still create the database — the password path is the fallback, not a failure."
  }

  # No adoption lookup, so no CLOUD_IAM_SERVICE_ACCOUNT user and no identity to annotate a KSA with.
  assert {
    condition = alltrue([
      length(data.google_service_account.app_db_adopted) == 0,
      length(google_service_account_iam_member.app_db_wi) == 0,
      output.cloud_sql_iam_user == null,
      output.cloud_sql_app_gsa_email == null,
    ])
    error_message = "Without an adopted account nothing keyless may be built, and the outputs must be null rather than a login nothing can use."
  }

  # And the operator is TOLD, rather than silently getting password auth they did not ask for.
  expect_failures = [check.keyless_cloud_sql_app_identity_wired]
}

# The paired negative: with IAM auth off the check must stay silent, so the warning above means
# something. A guard that always fires is one people learn to ignore.
run "a_database_without_iam_auth_warns_about_nothing" {
  command = plan

  variables {
    cloud_sql_iam_auth = false
  }

  assert {
    condition     = length(module.cloud_sql) == 1 && length(data.google_service_account.app_db_adopted) == 0
    error_message = "A plain password-auth database must be created with no keyless identity attached."
  }
}

################################################################################
# 3. DOCUMENTED GAP — the positive direction is not reachable here
################################################################################
#
# What is NOT covered: that setting the variable WITH a cluster resolves the adopted account, binds
# it to the app KSA, and lands its email in `app_iam_sa_email`. That needs `provision_gke = true`,
# which is NOT PLANNABLE UNDER MOCKS on GCP — modules/gke/outputs.tf indexes
# `google_container_cluster.cluster.master_auth[0]`, a COMPUTED-ONLY BLOCK that tofu's mock leaves
# empty and that `mock_resource` refuses to override ("Invalid override for block field
# `master_auth`"). The long note in checks_cluster_optional.tftest.hcl §2 has the full finding; this
# file inherits the same ceiling rather than working around it by loosening a real apply-path output.
#
# What still anchors the adoption path against deletion: every run above NAMES
# `data.google_service_account.app_db_adopted` and `google_service_account_iam_member.app_db_wi`, so
# removing either stops this file parsing rather than letting it pass. The positive direction remains
# covered only by a real apply — which is main-gated (the gcp T2 nightly).
