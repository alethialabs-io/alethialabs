# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Loud invariants. A `check` fails the plan/apply if a security property of this grant regresses, so
# a boundary that stopped being a boundary — or a grant that quietly widened — cannot ship silently.

# ── The proof must actually CROSS a project boundary ────────────────────────────────────────────
# Same-project is the failure that looks most like success: everything applies, ESO reads the
# secret, the digest matches, and the run reports a cross-project read it never performed.
check "target_is_not_the_cluster_project" {
  assert {
    condition     = var.target_project_id != var.cluster_project_id
    error_message = "target_project_id equals cluster_project_id — a read inside one project proves nothing about crossing a boundary, and would report a cross-project capability that was never exercised."
  }
}

# ── The granted identity must not live in the target project ───────────────────────────────────
# The GSA belongs to project A (next to the cluster). One that lives in B would make the grant
# local, which is the same false-positive one step further along.
check "granted_sa_is_foreign_to_the_target" {
  assert {
    condition     = !endswith(var.cluster_external_secrets_sa, "@${var.target_project_id}.iam.gserviceaccount.com")
    error_message = "cluster_external_secrets_sa belongs to target_project_id — the grant would be project-local and the e2e would prove an in-project read, not a cross-project one."
  }
}

# ── The grant stays on ONE secret ───────────────────────────────────────────────────────────────
# This identity is long-lived by construction (it has to outlive the nightly's cluster), so the
# blast radius of widening it is permanent. A project-level binding is refused here rather than
# reviewed later.
check "grant_is_secret_scoped" {
  assert {
    condition     = google_secret_manager_secret_iam_member.canary_reader.secret_id == google_secret_manager_secret.canary.secret_id
    error_message = "the secretAccessor grant must name the canary secret, never the project — a standing identity with project-wide read is a permanent widening, not a test fixture."
  }
}

# ── The canary must carry a real value ──────────────────────────────────────────────────────────
# An empty canary makes the sha256 comparison in the e2e trivially satisfiable by an empty read,
# which is the vacuous-assertion shape the proof exists to avoid.
check "canary_value_is_substantive" {
  assert {
    condition     = length(var.canary_value) >= 16
    error_message = "canary_value must be at least 16 characters — a short or empty canary makes the e2e's digest comparison satisfiable by an empty read."
  }
}
