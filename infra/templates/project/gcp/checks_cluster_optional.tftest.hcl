# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that `provision_gke = false` plans AND builds nothing that needs a cluster — the GCP half of
# #1772 (AWS: checks_cluster_optional.tftest.hcl in ../aws).
#
# GCP was cited as the PRECEDENT for that fix, and for the bare shape it genuinely was:
# checks_naming.tftest.hcl turns every provision_* flag off and passes. But turning everything off at
# once is exactly the shape that cannot find this bug class. The defect is a cluster-less shape with
# an ADD-ON REQUESTED, and GCP had two of them:
#
#   locals.enable_gar_pull    (registry-pull.tf)   — cross-project Artifact Registry pull identity
#   locals.enable_app_db_iam  (app-db-identity.tf) — keyless Cloud SQL app identity
#
# Neither carried `var.provision_gke`, so both created a google_service_account plus a
# google_service_account_iam_member binding it into the GKE Workload Identity pool. And GCP fails
# LATER than AWS did, which is why nothing caught it: `member` names the pool as a plain STRING
# ("serviceAccount:<project>.svc.id.goog[ns/ksa]") rather than indexing module.gke, so there is no
# "Invalid index" to trip the plan. It planned clean and died at APPLY:
#
#   Error 400: Identity Pool does not exist (<project>.svc.id.goog)
#
# — the same error workload-identity.tf already records from a real apply. A plan-time crash is
# found by CI; an apply-time one is found by a customer, halfway through provisioning.
#
# Both sides are pinned: cluster-less must build no cluster-scoped identity, and the cluster-ful
# shape must still build them. Without the second half, deleting the identities would pass.

mock_provider "google" {
  # The mock returns a generated string for every unset computed attribute, and the VPC's self_link
  # flows straight into google_sql_database_instance.settings.ip_configuration.private_network, which
  # the provider parses against a strict regexp before any API call. Not under test — it must merely
  # parse. (checks_naming.tftest.hcl needs no mocked attributes because it provisions nothing.)
  # There is deliberately NO mock_resource for google_container_cluster. Every run in this file is
  # cluster-less, so that resource is never planned and a mock for it would be dead scaffolding.
  # It could not serve the cluster-ful direction either: `master_auth` is a computed-only BLOCK,
  # and overriding it is rejected outright with "Invalid override for block field `master_auth`".
  # See the long note at the foot of this file.
  mock_resource "google_compute_network" {
    defaults = {
      self_link = "https://www.googleapis.com/compute/v1/projects/mock-project/global/networks/mock-vpc"
      id        = "projects/mock-project/global/networks/mock-vpc"
    }
  }
}
mock_provider "google-beta" {}
mock_provider "random" {}

# NOT mocked, deliberately: `kubernetes` and `helm`. main.tf's two provider blocks index
# module.gke[0] and cannot take a `count`, so they are guarded with try() instead. Measured on the
# aws template: `mock_provider "kubernetes" {}` replaces the provider CONFIGURATION wholesale, so its
# body is never evaluated and the mock HIDES an unguarded index rather than catching it. Leaving them
# unmocked costs nothing here (the template declares no kubernetes_*/helm_* resources, so tofu prunes
# both configs) and keeps the door shut on a false green.

variables {
  project_id   = "mock-project"
  region       = "europe-west3"
  environment  = "production"
  project_name = "alethia-nl"

  # THE shape under test. Every run below inherits it unless it deliberately turns the cluster back
  # on to pin the other side of a guard.
  provision_gke = false

  # Everything that hangs off the cluster starts off, so each run switches exactly one thing on and
  # a failure is attributable.
  create_cloud_sql       = false
  cloud_sql_iam_auth     = false
  registry_pull_provider = "native"
}

################################################################################
# 1. The cluster-less shape with every cluster-scoped add-on REQUESTED
################################################################################

# The run checks_naming.tftest.hcl could never have been: the cluster is off while the two identities
# that federate through it are switched ON. Both must be silently inert — and inert means ABSENT, not
# "created and broken at apply".
run "clusterless_still_plans_with_every_cluster_identity_requested" {
  command = plan

  variables {
    registry_pull_provider = "gar-xacct"
    create_cloud_sql       = true
    cloud_sql_iam_auth     = true
  }

  assert {
    condition     = length(module.gke) == 0
    error_message = "provision_gke = false must produce no GKE module instance."
  }

  # The cross-project GAR pull identity. The GSA exists only to be impersonated by an in-cluster KSA
  # through Workload Identity, so with no cluster there is no KSA, no pool, and nothing to create.
  assert {
    condition = alltrue([
      length(google_service_account.gar_pull) == 0,
      length(google_service_account_iam_member.gar_pull_wi) == 0,
    ])
    error_message = "gar-xacct without a cluster must create no pull GSA and no Workload Identity binding — the identity pool it would bind into does not exist."
  }

  # The keyless Cloud SQL app identity, same shape. The app GSA is now ADOPTED, not created — the
  # project-scoped cloudsql grants moved to the customer's connector bootstrap because writing them
  # needs resourcemanager.projects.setIamPolicy, which the provisioner does not hold. So what must be
  # absent here is the adoption LOOKUP and the Workload Identity binding.
  assert {
    condition = alltrue([
      length(data.google_service_account.app_db_adopted) == 0,
      length(google_service_account_iam_member.app_db_wi) == 0,
    ])
    error_message = "cloud_sql_iam_auth without a cluster must resolve no adopted app GSA and no Workload Identity binding."
  }

  # Cloud SQL itself is NOT cluster-scoped and must still be built. Without this the assertions above
  # could be satisfied by disabling the database alongside the cluster, breaking a real shape
  # (a managed database for an app that runs elsewhere) in order to fix a crash.
  assert {
    condition     = length(module.cloud_sql) == 1
    error_message = "Cloud SQL is independent of the cluster and must still be created."
  }

  # Both identity checks must still SPEAK on this shape. They are keyed on the `*_requested` locals
  # precisely so that folding `provision_gke` into the build predicates did not silence them — a
  # cluster-less keyless request is worth reporting, it is just not worth half-building.
  expect_failures = [
    check.keyless_cloud_sql_app_identity_wired,
    check.gar_pull_xacct_identity_present,
  ]
}

# The bare cluster-less shape with nothing requested must stay SILENT. Paired with the run above this
# pins that the two checks report a real misconfiguration rather than firing on every cluster-less
# plan — a guard that always fires is one people learn to ignore.
run "a_bare_clusterless_project_warns_about_nothing" {
  command = plan

  assert {
    condition = alltrue([
      length(google_service_account.gar_pull) == 0,
      length(data.google_service_account.app_db_adopted) == 0,
      length(module.gke) == 0,
    ])
    error_message = "A cluster-less project that requested no cluster identities must create none — and warn about none."
  }
}

# A database with IAM auth but no cluster is the shape whose apply died at "Identity Pool does not
# exist". Separated from the run above so the database graph is planned on its own and a failure
# names its own file.
run "a_keyless_database_without_a_cluster_plans" {
  command = plan

  variables {
    create_cloud_sql   = true
    cloud_sql_iam_auth = true
  }

  # The DB is built; the app-side IAM login is not, because there is no workload identity to grant it
  # to. cloud-sql.tf passes app_iam_sa_email = null, so no CLOUD_IAM_SERVICE_ACCOUNT user is
  # registered for an identity that could never authenticate.
  assert {
    condition     = length(module.cloud_sql) == 1 && length(data.google_service_account.app_db_adopted) == 0
    error_message = "A keyless-requested database without a cluster must still be created, with no app identity attached."
  }

  assert {
    condition     = output.cloud_sql_iam_user == null && output.cloud_sql_app_gsa_email == null
    error_message = "With no cluster the keyless Cloud SQL app identity outputs must be null, not a login nothing can use."
  }

  expect_failures = [check.keyless_cloud_sql_app_identity_wired]
}

################################################################################
# 2. The OTHER side — DOCUMENTED GAP, not an oversight
################################################################################
#
# The aws suite closes this file's obvious hole with `a_cluster_still_creates_every_irsa_role`:
# without it, deleting every identity would satisfy every assertion above. GCP CANNOT have that run,
# and the reason is worth writing down so nobody spends the afternoon rediscovering it.
#
# `provision_gke = true` is NOT PLANNABLE UNDER MOCKS, at all, on any branch:
#
#   Error: Invalid index
#     on modules/gke/outputs.tf line 14, in output "cluster_ca_certificate":
#     value = google_container_cluster.cluster.master_auth[0].cluster_ca_certificate
#     google_container_cluster.cluster.master_auth is empty list of object
#
# `master_auth` is a COMPUTED-ONLY BLOCK. tofu's mock leaves it an empty list, and unlike the aws
# provider's aws_eks_cluster.certificate_authority it cannot be populated —
# `mock_resource "google_container_cluster" { defaults = { master_auth = [...] } }` is rejected
# outright with "Invalid override for block field `master_auth`". Verified against origin/dev, so
# this predates #1772 and is exactly why checks_naming.tftest.hcl turns every provision_* flag off.
#
# Deliberately NOT worked around by loosening modules/gke/outputs.tf to `one(...[*]...)`: that is a
# real cluster output on the real apply path, and trading a fail-closed index for a null so that a
# TEST can run is the wrong side of the bargain — the same trade this pass rejected in aws/rds.tf.
# The fix, if someone wants this coverage, is to hoist the derivation to the root module where a
# mock can reach it.
#
# What still anchors the cluster-scoped resources against deletion, absent that run: every assertion
# above NAMES them (`google_service_account.gar_pull`, `google_service_account_iam_member.app_db_wi`,
# …), and `expect_failures` names both `check` blocks. Delete any of them and this file stops
# parsing rather than passing. What is genuinely NOT covered is the positive direction — that they
# are created when the cluster IS on. On GCP that remains covered only by a real apply.

################################################################################
# 3. The cluster outputs
################################################################################

# GCP's outputs were already guarded (`var.provision_gke ? module.gke[0].x : null`) and are the idiom
# the AWS fix was modelled on. Pinned here so the precedent stays a precedent: the runner harvests
# root outputs into jobs.execution_metadata, where a null is a legible "absent" and an error is a
# failed job.
run "clusterless_cluster_outputs_are_null" {
  command = plan

  assert {
    condition = alltrue([
      output.gke_cluster_name == null,
      output.gke_cluster_endpoint == null,
      output.gke_cluster_ca_certificate == null,
    ])
    error_message = "Cluster outputs must be null on a cluster-less shape, not an Invalid index error."
  }
}
