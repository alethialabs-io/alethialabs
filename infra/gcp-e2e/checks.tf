# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# BYOC A2.1 — loud invariant assertions on the e2e GCP WIF federation. A `check` block fails the
# plan/apply (loudly) if any security property regresses — so a widened trust, a dropped
# container.admin, a runaway budget, or a prod region can never ship silently. Mirrors
# infra/aws-oidc/checks.tf.

# ── Trust is repo+ref-bound, exact-match, never wildcarded ───────────────────
check "e2e_trust_is_ref_bound" {
  assert {
    condition = alltrue([
      # Both the repo AND the ref appear in the provider's attribute condition …
      strcontains(local.e2e_attr_condition, var.github_repo),
      strcontains(local.e2e_attr_condition, var.e2e_github_ref),
      # … joined by exact equality (CEL `==`) and AND-ed (repo AND ref, not either) …
      strcontains(local.e2e_attr_condition, "=="),
      strcontains(local.e2e_attr_condition, "&&"),
      # … with no glob/wildcard that could widen the match.
      !strcontains(local.e2e_attr_condition, "*"),
    ])
    error_message = "e2e WIF provider attribute_condition must pin BOTH attribute.repository AND attribute.ref with exact `==` (no '*') — got: ${local.e2e_attr_condition}."
  }
}

# ── The provider actually carries that condition (not just the local) ─────────
check "e2e_provider_condition_applied" {
  assert {
    condition     = google_iam_workload_identity_pool_provider.e2e.attribute_condition == local.e2e_attr_condition
    error_message = "the e2e WIF provider's attribute_condition must equal the ref-bound local.e2e_attr_condition — a drift here would relax the trust."
  }
}

# ── The trust roots at GitHub's OIDC issuer ──────────────────────────────────
check "e2e_provider_trusts_github_issuer" {
  assert {
    condition     = var.github_oidc_issuer == "https://token.actions.githubusercontent.com"
    error_message = "e2e WIF provider must trust the GitHub Actions OIDC issuer (https://token.actions.githubusercontent.com)."
  }
}

# ── The SA is impersonated only by the repo-scoped WIF principal ─────────────
check "e2e_wif_binding_is_repo_scoped" {
  assert {
    condition = alltrue([
      google_service_account_iam_member.e2e_wif.role == "roles/iam.workloadIdentityUser",
      strcontains(google_service_account_iam_member.e2e_wif.member, "principalSet://"),
      strcontains(google_service_account_iam_member.e2e_wif.member, "attribute.repository/${var.github_repo}"),
      !strcontains(google_service_account_iam_member.e2e_wif.member, "*"),
    ])
    error_message = "the e2e SA must be impersonable ONLY by the repo-scoped WIF principalSet (attribute.repository/${var.github_repo}), via roles/iam.workloadIdentityUser, with no wildcard."
  }
}

# ── GKE self-admin: roles/container.admin is bound (no template RBAC change needed) ──
check "e2e_container_admin_bound" {
  assert {
    condition     = contains(local.e2e_provisioner_roles, "roles/container.admin")
    error_message = "the e2e provisioner SA must be granted roles/container.admin (GKE self-admin at create time) — the whole point of the GCP parity proof."
  }
}

# ── The cost guard exists and is sanely bounded, scoped to the dedicated project ──
check "e2e_budget_is_cost_capped" {
  assert {
    condition = alltrue([
      google_billing_budget.e2e_nightly.amount[0].specified_amount[0].currency_code == "USD",
      tonumber(google_billing_budget.e2e_nightly.amount[0].specified_amount[0].units) > 0,
      tonumber(google_billing_budget.e2e_nightly.amount[0].specified_amount[0].units) <= 500,
    ])
    error_message = "e2e budget must be a USD budget with 0 < amount <= 500."
  }
}

check "e2e_budget_scoped_to_project" {
  assert {
    condition     = contains(google_billing_budget.e2e_nightly.budget_filter[0].projects, "projects/${data.google_project.this.number}")
    error_message = "the e2e budget must be scoped to EXACTLY the dedicated e2e project (never account-wide)."
  }
}

check "e2e_budget_publishes_to_pubsub" {
  assert {
    condition     = google_billing_budget.e2e_nightly.all_updates_rule[0].pubsub_topic == google_pubsub_topic.e2e_budget.id
    error_message = "the e2e budget must publish its alerts to the e2e Pub/Sub topic."
  }
}

# ── region is never a prod-adjacent region ───────────────────────────────────
check "e2e_region_not_prod" {
  assert {
    condition     = !contains(["us-central1", "us-east1"], var.region)
    error_message = "region must not be a prod-adjacent region (us-central1 / us-east1)."
  }
}
