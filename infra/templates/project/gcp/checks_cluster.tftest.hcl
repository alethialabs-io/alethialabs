# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof for the two GKE node-shape gates in checks_cluster.tf.
#
# What this file can and cannot reach, stated up front so nobody reads a gap here as an oversight:
# `provision_gke = true` is NOT PLANNABLE under mocks on this template at all — modules/gke's
# `master_auth` is a computed-only block that tofu's mock leaves empty and that `mock_resource`
# refuses to override. The long note in checks_cluster_optional.tftest.hcl records the whole finding.
# So the node pool's rendered `node_config` cannot be asserted on from a test on GCP; it is covered
# only by a real apply.
#
# What IS reachable is the half that decides whether an apply happens: both gates are written
# against root `local.`/`var.` and nothing else, deliberately, so the blocking decision is testable
# even though the resource it protects is not. That split is the same one checks_naming.tf makes.

mock_provider "google" {}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  project_id   = "mock-project"
  region       = "europe-west3"
  environment  = "production"
  project_name = "alethia-nl"

  # Nothing is provisioned: this file is about the gates, not about the graph. The gates are
  # deliberately NOT gated on provision_gke (see checks_cluster.tf), which is what lets them be
  # measured here at all.
  provision_gke = false
}

################################################################################
# The default shape — every new knob absent
################################################################################

# The load-bearing run. `gke_volume_iops`/`gke_volume_throughput` default to null and
# `gke_spot`/`gke_preemptible` to false, so a template that gained four node knobs must still plan
# for a project that set none of them. If this ever fails, the defaults stopped being neutral.
run "the_default_node_shape_asks_for_nothing_and_plans" {
  command = plan

  assert {
    condition     = local.gke_boot_disk_performance_requested == false
    error_message = "With gke_volume_iops and gke_volume_throughput unset, no boot-disk performance may be requested — the module renders no boot_disk block on this predicate, and that absence is the whole zero-diff claim."
  }

  assert {
    condition     = var.gke_spot == false && var.gke_preemptible == false
    error_message = "gke_spot must default to FALSE. It shipped `default = true` while being read by nothing, so every node pool this template built ran on-demand; wiring it at true would convert every existing pool to Spot on the next apply."
  }

  assert {
    condition     = var.gke_disk_type == "pd-standard"
    error_message = "Widening the gke_disk_type validation to admit hyperdisk-balanced must not move the default off pd-standard."
  }
}

################################################################################
# CLUSTER-001 — provisioned performance without a hyperdisk
################################################################################

# Either figure alone must arm the predicate; a guard that only noticed the pair would let the
# common single-knob case through.
run "iops_alone_requests_boot_disk_performance" {
  command = plan

  variables {
    gke_disk_type   = "hyperdisk-balanced"
    gke_volume_iops = 3000
  }

  assert {
    condition     = local.gke_boot_disk_performance_requested
    error_message = "gke_volume_iops on its own must count as a boot-disk performance request."
  }
}

run "throughput_alone_requests_boot_disk_performance" {
  command = plan

  variables {
    gke_disk_type         = "hyperdisk-balanced"
    gke_volume_throughput = 140
  }

  assert {
    condition     = local.gke_boot_disk_performance_requested
    error_message = "gke_volume_throughput on its own must count as a boot-disk performance request."
  }
}

# The gate itself. On any disk type but hyperdisk-balanced, Google accepts the value and ignores it —
# the customer is billed for baseline performance while the template says otherwise. That is a
# silent no-op, so the plan stops.
run "iops_on_a_pd_disk_blocks_the_plan" {
  command = plan

  variables {
    gke_disk_type   = "pd-balanced"
    gke_volume_iops = 3000
  }

  expect_failures = [
    check.gke_provisioned_disk_performance_needs_hyperdisk,
    terraform_data.gke_node_shape_guard,
  ]
}

run "throughput_on_the_default_pd_standard_disk_blocks_the_plan" {
  command = plan

  variables {
    gke_volume_throughput = 140
  }

  expect_failures = [
    check.gke_provisioned_disk_performance_needs_hyperdisk,
    terraform_data.gke_node_shape_guard,
  ]
}

# The other side: hyperdisk-balanced must be an ACCEPTED value, not merely a listed one. Without
# this run the gate could be satisfied by a validation that rejects every disk type, and the two new
# knobs would be unreachable on all of them.
run "hyperdisk_balanced_accepts_both_figures" {
  command = plan

  variables {
    gke_disk_type         = "hyperdisk-balanced"
    gke_volume_iops       = 3000
    gke_volume_throughput = 140
  }

  assert {
    condition     = local.gke_boot_disk_performance_requested && var.gke_disk_type == "hyperdisk-balanced"
    error_message = "hyperdisk-balanced with both figures set is the ONE shape these knobs exist for; it must plan."
  }
}

################################################################################
# CLUSTER-002 — one interruptible tier, not two
################################################################################

run "spot_and_preemptible_together_block_the_plan" {
  command = plan

  variables {
    gke_spot        = true
    gke_preemptible = true
  }

  expect_failures = [
    check.gke_one_interruptible_tier,
    terraform_data.gke_node_shape_guard,
  ]
}

# Both single-tier shapes must still plan, or the gate above would be satisfiable by refusing
# interruptible capacity outright — which is the gap this change exists to close.
run "spot_alone_plans" {
  command = plan

  variables {
    gke_spot = true
  }

  assert {
    condition     = var.gke_spot && !var.gke_preemptible
    error_message = "Spot on its own must be an accepted node shape."
  }
}

run "preemptible_alone_plans" {
  command = plan

  variables {
    gke_preemptible = true
  }

  assert {
    condition     = var.gke_preemptible && !var.gke_spot
    error_message = "The legacy preemptible tier on its own must remain an accepted node shape."
  }
}
