# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the canvas's point-in-time-recovery switch reaches the Firestore database, and that it
# reaches it in BOTH positions.
#
# The offer-parity guard cannot prove this. Its L5 question for a root scalar is "is
# `firestore_point_in_time_recovery` declared, and does something on the chain read `var.` of it" —
# and the module argument in firestore.tf satisfies that on its own. Delete
# `point_in_time_recovery_enablement` from the resource, keep the module argument, and the guard
# still reports the cell wired while the database is built without PITR. That gap is the reason this
# file exists, and it is the only artifact in the tree that closes it.
#
# Both directions are asserted deliberately. A suite that only pinned the ENABLED case would pass
# just as happily for a template that hardcoded PITR on — which would be a real, billable behaviour
# change applied to every project that never asked for it.
#
# `modules/**/*.tftest.hcl` is silently never executed by `tofu test` (root-level only), which is
# why this sits here rather than next to the module it tests.
#
# Providers are mocked and no cluster is provisioned, so this needs no credentials and runs on any PR.

mock_provider "google" {}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  project_id   = "mock-project"
  region       = "europe-west3"
  environment  = "staging"
  project_name = "alethia"

  # Only Firestore. Every other component is off so a failure here can only be about Firestore.
  # These are the REAL variable names from variables.tf — tofu's test harness silently IGNORES an
  # undeclared variable, so a typo would leave a component ON while the block claimed otherwise.
  # (`provision_network` stays ON: turning it off is a brownfield choice that trips
  # checks_network.tf's precondition, not a "component off" toggle. See checks_naming.tftest.hcl.)
  provision_gke               = false
  provision_artifact_registry = false
  create_cloud_sql            = false
  create_memorystore          = false
  create_memorystore_valkey   = false
  create_pubsub               = false
  create_cloud_storage        = false
  cloud_dns_enabled           = false
  cloud_armor_enabled         = false

  create_firestore = true
}

# ── OFF ──────────────────────────────────────────────────────────────────────────────
#
# The OFF position is spelled DISABLED rather than left unset, and this run is what keeps it that
# way. A `null` here would be indistinguishable from "the argument was never wired", which is
# precisely the state this whole change is undoing.
#
# It is also the compatibility half: DISABLED is Firestore's own default, so this is the value every
# database already in the field carries. Asserting it byte-for-byte means turning the switch OFF —
# or leaving it alone, which is what every existing project does — changes nothing.
run "pitr_off_plans_the_database_with_recovery_disabled" {
  command = plan

  variables {
    firestore_point_in_time_recovery = false
  }

  assert {
    condition     = module.firestore[0].point_in_time_recovery_enablement == "POINT_IN_TIME_RECOVERY_DISABLED"
    error_message = "With the switch off the database must plan POINT_IN_TIME_RECOVERY_DISABLED, got ${coalesce(module.firestore[0].point_in_time_recovery_enablement, "null — the resource does not read the variable at all")}."
  }
}

# ── ON ───────────────────────────────────────────────────────────────────────────────
#
# The half that fails the moment the argument stops being read off the variable: with the argument
# gone the provider default reasserts itself and this plans DISABLED, while the OFF run above keeps
# passing. Neither run is meaningful without the other.
run "pitr_on_plans_the_database_with_recovery_enabled" {
  command = plan

  variables {
    firestore_point_in_time_recovery = true
  }

  assert {
    condition     = module.firestore[0].point_in_time_recovery_enablement == "POINT_IN_TIME_RECOVERY_ENABLED"
    error_message = "With the switch on the database must plan POINT_IN_TIME_RECOVERY_ENABLED, got ${coalesce(module.firestore[0].point_in_time_recovery_enablement, "null — the resource does not read the variable at all")}."
  }
}

# ── The database is otherwise unchanged ──────────────────────────────────────────────
#
# PITR is an in-place PATCH on `google_firestore_database` — `point_in_time_recovery_enablement` is
# not ForceNew in hashicorp/google (checked at v5.0.0, the constraint floor, and at v6.50.0, the
# pinned version). That matters more here than it would elsewhere, because this module sets
# `deletion_policy = "DELETE"` outside production: if enabling PITR replaced the database, turning
# on a recovery feature would destroy the data it was turned on to protect.
#
# A tofu plan cannot state "not ForceNew" directly, so this pins the observable proxy — the name,
# which is the resource's identity and the one ForceNew field this template derives. If a future
# change ever couples the switch to naming, this run is what says so before an apply does.
run "the_switch_does_not_touch_the_database_identity" {
  command = plan

  variables {
    firestore_point_in_time_recovery = true
  }

  assert {
    condition     = module.firestore[0].database_name == "alethia-staging-firestore"
    error_message = "Point-in-time recovery must not change the database name — the name is ForceNew, so a changed name would replace the database. Got ${module.firestore[0].database_name}."
  }
}
