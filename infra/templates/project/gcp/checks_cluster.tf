# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# GKE node-shape gates (template-parity: boot-disk performance + interruptible capacity).
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.
#
# Why these are `terraform_data` preconditions and not `check` blocks: a `check` NEVER blocks an
# apply, it only warns. Both conditions below describe a knob that would be ACCEPTED by tofu and
# then ignored or rejected by Google — the exact "declared, reachable, silently a no-op" shape the
# offer-parity guard exists to catch. A warning is not enough for that; the plan has to stop.
# `check` blocks are rendered alongside so the same violation is also legible at plan time.
#
# NOT gated on `var.provision_gke`, unlike checks_compat.tf's version gate, and for two reasons.
# (1) Every variable these read defaults to null/false, so a project that did not ask for the knob
# passes whether or not it has a cluster — there is no cluster-less plan to spare. (2) A node-pool
# knob set on a project with no node pool is itself worth stopping: it reaches nothing, and silence
# would let a customer believe they had bought provisioned IOPS. The gating also has to stay off for
# the gates to be TESTABLE at all — `provision_gke = true` is unplannable under mocks on this
# template (modules/gke's computed-only `master_auth` cannot be overridden; the long note in
# checks_cluster_optional.tftest.hcl records why), so a guard behind that flag could never be run.

# ── CLUSTER-001 · provisioned boot-disk performance needs a hyperdisk ────────────────────────────
# The provider's own schema text: provisioned_iops and provisioned_throughput are "Only valid with
# disk type hyperdisk-balanced". Set either against pd-standard/pd-ssd/pd-balanced and the plan is
# clean, the apply is clean, and the customer pays for a disk that performs at its type's baseline.
check "gke_provisioned_disk_performance_needs_hyperdisk" {
  assert {
    condition     = !local.gke_boot_disk_performance_requested || var.gke_disk_type == "hyperdisk-balanced"
    error_message = "CLUSTER-001: gke_volume_iops / gke_volume_throughput require gke_disk_type = \"hyperdisk-balanced\" (got \"${var.gke_disk_type}\"); terraform_data.gke_node_shape_guard blocks apply."
  }
}

# ── CLUSTER-002 · Spot and preemptible are one choice, not two ───────────────────────────────────
# GCP's two interruptible tiers are mutually exclusive on a node pool; preemptible is the legacy
# one. The API rejects both, minutes into the apply — this moves that to plan time.
check "gke_one_interruptible_tier" {
  assert {
    condition     = !(var.gke_spot && var.gke_preemptible)
    error_message = "CLUSTER-002: gke_spot and gke_preemptible are mutually exclusive — preemptible is the legacy tier; pick one. terraform_data.gke_node_shape_guard blocks apply."
  }
}

# Fail-closed apply gate for both of the above. No bypass variable, for the same reason
# checks_compat.tf has none: a waiver is a runner-layer concern, not a template knob.
resource "terraform_data" "gke_node_shape_guard" {
  lifecycle {
    precondition {
      condition     = !local.gke_boot_disk_performance_requested || var.gke_disk_type == "hyperdisk-balanced"
      error_message = "CLUSTER-001: gke_volume_iops / gke_volume_throughput are only honored on gke_disk_type = \"hyperdisk-balanced\" (got \"${var.gke_disk_type}\"). Apply blocked fail-closed — on any other disk type Google accepts the plan and silently ignores the figure, so the knob would bill for performance it never delivers."
    }

    precondition {
      condition     = !(var.gke_spot && var.gke_preemptible)
      error_message = "CLUSTER-002: gke_spot and gke_preemptible cannot both be true — GCP's node pool carries ONE interruptible tier and preemptible is the legacy spelling of it. Apply blocked fail-closed."
    }
  }
}
