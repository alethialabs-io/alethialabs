# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Loud invariant assertions on the e2e federated stack (per infra IaC rule #2). A `check` block fails
# the plan/apply if any security property regresses — a wildcarded federation subject, a role
# assignment that escaped the subscription scope, or a runaway budget can never ship silently. Mirrors
# infra/aws-oidc/checks.tf.

# ── Federation subjects are exact + ref/environment-bound, never wildcarded ───
check "federation_subjects_exact" {
  assert {
    condition = alltrue([
      for c in azuread_application_federated_identity_credential.github :
      can(regex("^repo:[^:*]+/[^:*]+:(ref:refs/heads/[^:*]+|environment:[^:*]+)$", c.subject))
    ])
    error_message = "every federated credential subject must be an EXACT repo:<owner>/<repo>:ref:refs/heads/<branch> (or :environment:<env>) with no '*' wildcard."
  }
}

# ── Federation trusts the GitHub OIDC issuer + the AzureAD token-exchange audience ────
check "federation_issuer_and_audience" {
  assert {
    condition = alltrue([
      for c in azuread_application_federated_identity_credential.github :
      c.issuer == local.github_oidc_issuer && contains(c.audiences, local.token_audience)
    ])
    error_message = "federated credentials must trust issuer ${local.github_oidc_issuer} and audience ${local.token_audience}."
  }
}

# ── At least the ref-based federation exists (a stack with no way in is misconfigured) ────
check "federation_ref_present" {
  assert {
    condition     = contains(keys(azuread_application_federated_identity_credential.github), "ref")
    error_message = "the ref-based federated credential (repo:<repo>:ref:refs/heads/<branch>) must exist — it is how the scheduled nightly federates in."
  }
}

# ── Every role assignment is scoped to the e2e subscription and NOTHING wider ────
check "role_assignments_subscription_scoped" {
  assert {
    condition = alltrue([
      azurerm_role_assignment.contributor.scope == local.subscription_scope,
      azurerm_role_assignment.user_access_admin.scope == local.subscription_scope,
      azurerm_role_assignment.aks_cluster_user.scope == local.subscription_scope,
    ])
    error_message = "all e2e role assignments must be scoped to the dedicated subscription (var.subscription_id) — never a management group or wider."
  }
}

# ── The AKS self-admin group is security-enabled + the e2e SP is its member ───
check "admin_group_wired" {
  assert {
    condition = alltrue([
      azuread_group.aks_admins.security_enabled,
      azuread_group_member.e2e_sp.member_object_id == azuread_service_principal.e2e.object_id,
    ])
    error_message = "the AKS admin group must be security-enabled and carry the e2e service principal as a member (else the runner's AAD token is not authorized)."
  }
}

# ── The cost guard exists and is sanely bounded ──────────────────────────────
check "budget_is_cost_capped" {
  assert {
    condition = alltrue([
      azurerm_consumption_budget_subscription.e2e.time_grain == "Monthly",
      azurerm_consumption_budget_subscription.e2e.amount > 0,
      azurerm_consumption_budget_subscription.e2e.amount <= 500,
    ])
    error_message = "the e2e budget must be a Monthly consumption budget with a 0 < amount <= 500 cap."
  }
}
