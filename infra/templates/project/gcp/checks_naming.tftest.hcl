# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that NAMING-001 actually REFUSES what it claims to refuse.
#
# The naming-stem invariant shipped for months as a bare `check` block, which only ever emits a
# WARNING — so an over-long stem sailed through to apply and the GCP API rejected the derived id
# mid-provision, after the cluster and network already existed (#1716). A guard nobody has seen fail
# is indistinguishable from no guard, so this asserts the terraform_data precondition BLOCKS.
#
# Providers are mocked and provision_gke is off, so this needs no credentials and runs on any PR.

mock_provider "google" {}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  project_id = "mock-project"
  region     = "europe-west3"

  # Everything the template can provision is off: NAMING-001 is decided from plain variables, before
  # any resource exists, and that is exactly the property under test.
  provision_gke               = false
  provision_cloud_sql         = false
  provision_memorystore       = false
  provision_cloud_dns         = false
  provision_cloud_armor       = false
  provision_cloud_storage     = false
  provision_artifact_registry = false
  provision_pubsub            = false
  provision_secret_manager    = false
  provision_firestore         = false
}

# The stem at exactly its documented maximum (30 chars) must PASS. Paired with the 31-char run
# below this pins the boundary from BOTH sides — without it the guard could be satisfied by
# refusing everything, and an off-by-one that rejected legal names would go unnoticed.
run "stem_at_exactly_the_limit_is_accepted" {
  command = plan

  variables {
    environment  = "production"          # 10
    project_name = "alethia-platform-ab" # 19  -> "production-alethia-platform-ab" = 30
  }
}

# The case observed in #1716 — well inside the old 30-char check, which is why it warned about
# nothing and the apply died at the GCP API instead.
run "the_1716_stem_is_accepted" {
  command = plan

  variables {
    environment  = "ovn07302018" # 11
    project_name = "alethia-nl"  # 10  -> 22
  }
}

# One character over the budget must BLOCK the plan. This is the assertion that distinguishes a real
# gate from the `check` block it replaces — and both halves of the pairing are expected, so neither
# can be quietly dropped: the check states the violation, the precondition refuses the apply.
#
# 31 is deliberate. Push the stem far enough (44+) and the google provider's own name regex rejects
# the VPC firewall id independently, which would let this run pass for the wrong reason. At 31 only
# NAMING-001 fires, so the failure being asserted is unambiguously ours.
run "stem_one_over_the_limit_blocks_the_plan" {
  command = plan

  variables {
    environment  = "production-env"   # 14
    project_name = "alethia-platform" # 16  -> "production-env-alethia-platform" = 31
  }

  expect_failures = [
    check.gcp_name_stem_within_limit,
    terraform_data.gcp_naming_guard,
  ]
}
