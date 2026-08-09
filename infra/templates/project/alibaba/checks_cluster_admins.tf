# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cluster-admin grant gate (#2005). Own file per the rule in checks_cluster.tf: each feature owns
# its checks file; never append to checks.tf.
#
# Same class as the node-shape gates — a shape tofu ACCEPTS that then does nothing. With
# provision_ack = false, cluster-admins.tf's for_each filters every entry away: the plan is clean,
# the apply is clean, and every listed principal ends up with NO grant while the config claims
# they are cluster admins. An access claim that silently grants nothing is worth stopping at least
# as hard as a disk knob, so the same check + fail-closed precondition pair applies (a bare
# `check` never blocks an apply).

# ── ADMINS-001 · cluster admins need a cluster ───────────────────────────────────────────────────
check "ack_cluster_admins_need_a_cluster" {
  assert {
    condition     = length(var.ack_cluster_admins) == 0 || var.provision_ack
    error_message = "ADMINS-001: ack_cluster_admins is set but provision_ack = false — there is no ACK cluster to grant admin on, so every listed principal would silently get nothing; terraform_data.ack_cluster_admins_guard blocks apply."
  }
}

# Fail-closed apply gate. No bypass variable, for the same reason checks_cluster.tf has none: a
# waiver is a runner-layer concern, deliberately not exposed in the template.
resource "terraform_data" "ack_cluster_admins_guard" {
  lifecycle {
    precondition {
      condition     = length(var.ack_cluster_admins) == 0 || var.provision_ack
      error_message = "ADMINS-001: ack_cluster_admins requires provision_ack = true. Apply blocked fail-closed — with no cluster the grants render nothing, and a config that CLAIMS cluster admins while granting none is an access lie, not a no-op."
    }
  }
}
