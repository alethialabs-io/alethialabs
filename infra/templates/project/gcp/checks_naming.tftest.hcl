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
  #
  # These are the REAL names from variables.tf. Eight of the ten this block used to set did not
  # exist — provision_cloud_sql, provision_memorystore, provision_cloud_dns, provision_cloud_armor,
  # provision_cloud_storage, provision_pubsub, provision_firestore, and provision_secret_manager
  # (which has no flag at all; the template has no secret-manager toggle). Tofu's test harness
  # silently IGNORES an undeclared variable, so the block read as "everything off" while only
  # provision_gke and provision_artifact_registry took effect and every other component planned at
  # its default. The test passed throughout, which is the problem: it proved far less than it
  # claimed, and nothing failed to say so.
  # provision_network stays ON, deliberately. Turning it off is a brownfield choice, not a
  # "component off" toggle: checks_network.tf's brownfield_subnet_guard precondition then requires a
  # resolvable external subnetwork and blocks the plan without one. That is the guard behaving
  # correctly, and it is also the first proof that these names now bind to something — under the old
  # misspelled list, setting a flag had no effect whatsoever.
  provision_gke               = false
  provision_artifact_registry = false
  create_cloud_sql            = false
  create_memorystore          = false
  create_memorystore_valkey   = false
  create_pubsub               = false
  create_firestore            = false
  create_cloud_storage        = false
  cloud_dns_enabled           = false
  cloud_armor_enabled         = false
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

################################################################################
# The GKE default node-pool name (local.gke_node_pool_name)
################################################################################
#
# The node pool is the one derived id NAMING-001 does NOT budget: it is solved by construction
# instead, falling back to a truncated-plus-digest form once the readable name would overflow GKE's
# 39-character cap. That fallback is the fix for a 400 that landed MID-APPLY (#1716), and its only
# interesting behaviour is a branch that triggers past a length threshold — so it is pinned here.
#
# Expected names are HARDCODED rather than recomputed from the same expression. Restating the
# derivation would assert only that it equals itself; a literal fails the moment an offset, the
# digest length or the threshold moves — which is the whole point.
#
# Every stem below is within the 30-character NAMING-001 budget, so these plans pass the gate and
# the only thing under test is the derivation. region = "europe-west3" -> short name "ew3", so the
# cluster is "gke-ew3-<environment>-<project_name>" and the pool appends "-default-pool" (13).

# 39 characters — the longest readable form GKE accepts. Must be kept BYTE-IDENTICAL: this is the
# name real clusters already carry, and a changed name forces replacement of the node pool.
run "node_pool_at_39_chars_keeps_the_readable_form" {
  command = plan

  variables {
    environment  = "production" # 10
    project_name = "alethia"    #  7  -> cluster 26, pool name 39
  }

  assert {
    condition     = local.gke_node_pool_name == "gke-ew3-production-alethia-default-pool"
    error_message = "A 39-character node-pool name must keep the readable form verbatim, got ${local.gke_node_pool_name}."
  }
}

# 40 characters — one over, the first name GKE rejects, so the fallback must engage. Paired with the
# run above, this pins the threshold from BOTH sides: without it a derivation that digested
# everything would pass, and without its partner one that never digested would.
run "node_pool_at_40_chars_falls_back_to_digest" {
  command = plan

  variables {
    environment  = "production" # 10
    project_name = "alethiax"   #  8  -> cluster 27, readable pool name 40
  }

  assert {
    condition     = local.gke_node_pool_name == "gke-ew3-production-alethiax-def-c493fea"
    error_message = "A 40-character node-pool name must fall back to truncate-plus-digest, got ${local.gke_node_pool_name}."
  }
}

# When the 31-character truncation lands exactly on a hyphen it is trimmed, so this name is 38
# characters, not 39. Asserting the literal keeps that trailing-hyphen handling from being dropped
# as an apparent no-op — "gke-ew3-production-alethia-abc--93b7723" would be an ugly, valid name.
run "node_pool_truncation_landing_on_a_hyphen_is_trimmed" {
  command = plan

  variables {
    environment  = "production"  # 10
    project_name = "alethia-abc" # 11  -> cluster 30, readable pool name 43
  }

  assert {
    condition     = local.gke_node_pool_name == "gke-ew3-production-alethia-abc-93b7723"
    error_message = "A truncation landing on a hyphen must trim it, got ${local.gke_node_pool_name}."
  }
}

# The two runs below are a PAIR and neither is meaningful alone. Both cluster names share their
# first 34 characters, so both collapse to the same 31-character truncation — only the digest can
# tell them apart, and it is taken over the FULL name for exactly that reason. Digesting the
# truncated stem instead would hand two different clusters one node-pool name.
run "node_pool_shared_prefix_a_gets_a_distinct_digest" {
  command = plan

  variables {
    environment  = "production"        # 10
    project_name = "alethia-platfrm-a" # 17  -> cluster 36, readable pool name 49
  }

  assert {
    condition     = local.gke_node_pool_name == "gke-ew3-production-alethia-plat-5bcc31a"
    error_message = "Expected the -a cluster's own digest, got ${local.gke_node_pool_name}."
  }
}

run "node_pool_shared_prefix_b_gets_a_distinct_digest" {
  command = plan

  variables {
    environment  = "production"        # 10
    project_name = "alethia-platfrm-b" # 17  -> same 31-char truncation as -a above
  }

  assert {
    condition     = local.gke_node_pool_name == "gke-ew3-production-alethia-plat-1d17b77"
    error_message = "Expected the -b cluster's own digest (distinct from -a's 5bcc31a), got ${local.gke_node_pool_name}."
  }
}
