# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# BYOC A1.1 — loud invariant assertions on the e2e-nightly role. A `check` block fails the
# plan/apply (loudly) if any security property of the role regresses — so a mis-scoped trust,
# a detached boundary, a lost region lock, or a runaway budget can never ship silently.

# ── Trust is ref-bound, never wildcarded ─────────────────────────────────────
check "e2e_trust_is_ref_bound" {
  assert {
    condition = alltrue([
      for s in local.e2e_subs :
      can(regex("^repo:[^:*]+/[^:*]+:(ref:refs/heads/[^:*]+|environment:[^:*]+)$", s))
    ])
    error_message = "e2e OIDC subject must be an EXACT repo:<owner>/<repo>:ref:refs/heads/<branch> (or :environment:<env>) with no '*' wildcard — got ${jsonencode(local.e2e_subs)}."
  }
}

check "e2e_trust_uses_string_equals_and_aud" {
  assert {
    # The rendered trust must pin the AWS STS audience and match the sub with StringEquals
    # (an exact match), never StringLike.
    condition = alltrue([
      strcontains(data.aws_iam_policy_document.e2e_nightly_trust.json, "sts.amazonaws.com"),
      strcontains(data.aws_iam_policy_document.e2e_nightly_trust.json, "token.actions.githubusercontent.com:sub"),
      !strcontains(data.aws_iam_policy_document.e2e_nightly_trust.json, "StringLike"),
    ])
    error_message = "e2e trust must pin aud=sts.amazonaws.com and match the sub with StringEquals (no StringLike)."
  }
}

# ── The permissions boundary is attached ─────────────────────────────────────
check "e2e_boundary_attached" {
  assert {
    condition     = aws_iam_role.e2e_nightly.permissions_boundary == aws_iam_policy.e2e_boundary.arn
    error_message = "e2e-nightly role must have the alethia-e2e-nightly-boundary permissions boundary attached."
  }
}

# ── IAM entities are path-scoped under /alethia-e2e/ ─────────────────────────
check "e2e_entities_path_scoped" {
  assert {
    condition = alltrue([
      aws_iam_role.e2e_nightly.path == "/alethia-e2e/",
      aws_iam_policy.e2e_boundary.path == "/alethia-e2e/",
    ])
    error_message = "e2e IAM role + boundary policy must be path-scoped under /alethia-e2e/."
  }
}

# ── The region lock + prod-resource isolation are present in the boundary ─────
check "e2e_boundary_region_locked" {
  assert {
    condition = alltrue([
      strcontains(data.aws_iam_policy_document.e2e_boundary.json, "aws:RequestedRegion"),
      strcontains(data.aws_iam_policy_document.e2e_boundary.json, "StringNotEquals"),
    ])
    error_message = "e2e boundary must deny actions outside e2e_region via an aws:RequestedRegion StringNotEquals condition."
  }
}

check "e2e_boundary_isolates_prod" {
  assert {
    condition = alltrue([
      # Guard against vacuity: strcontains(x, "") is always true, so an empty protected name
      # would pass AND degrade the deny ARN to a no-op — assert both names are non-empty first.
      var.state_bucket_name != "",
      var.prod_env_secret_name != "",
      strcontains(data.aws_iam_policy_document.e2e_boundary.json, var.state_bucket_name),
      strcontains(data.aws_iam_policy_document.e2e_boundary.json, var.prod_env_secret_name),
      strcontains(data.aws_iam_policy_document.e2e_boundary.json, "DenyTamperWithGuardrails"),
    ])
    error_message = "e2e boundary must deny access to the (non-empty) prod state bucket + prod secret and deny self-tamper on /alethia-e2e/."
  }
}

# ── The escalation guardrails are all present (regression tripwire) ───────────
check "e2e_boundary_escalation_guards_present" {
  assert {
    condition = alltrue([
      strcontains(data.aws_iam_policy_document.e2e_boundary.json, "DenyRoleHop"),
      strcontains(data.aws_iam_policy_document.e2e_boundary.json, "DenyAdminPolicyAttach"),
      strcontains(data.aws_iam_policy_document.e2e_boundary.json, "DenyOrgAndAccount"),
      strcontains(data.aws_iam_policy_document.e2e_boundary.json, "DenyProdTofuState"),
    ])
    error_message = "e2e boundary must keep the escalation guardrails (DenyRoleHop / DenyAdminPolicyAttach / DenyOrgAndAccount / DenyProdTofuState) — a regression that drops one must fail loudly."
  }
}

# ── The identity policy also carries the region lock (defence in depth) ───────
check "e2e_policy_region_locked" {
  assert {
    condition     = strcontains(data.aws_iam_policy_document.e2e_nightly.json, "aws:RequestedRegion")
    error_message = "e2e identity policy must also carry the region-deny (defence in depth)."
  }
}

# ── e2e_region is never a prod region ────────────────────────────────────────
check "e2e_region_not_prod" {
  assert {
    condition     = !contains(["eu-central-1", "eu-west-1"], var.e2e_region)
    error_message = "e2e_region must not be a prod region (eu-central-1 / eu-west-1)."
  }
}

# ── The cost guard exists and is sanely bounded ──────────────────────────────
check "e2e_budget_is_cost_capped" {
  assert {
    condition = alltrue([
      aws_budgets_budget.e2e_nightly.budget_type == "COST",
      aws_budgets_budget.e2e_nightly.time_unit == "MONTHLY",
      tonumber(aws_budgets_budget.e2e_nightly.limit_amount) > 0,
      tonumber(aws_budgets_budget.e2e_nightly.limit_amount) <= 500,
    ])
    error_message = "e2e budget must be a MONTHLY COST budget with a 0 < limit <= 500 USD cap."
  }
}

check "e2e_budget_publishes_to_sns" {
  assert {
    condition     = strcontains(data.aws_iam_policy_document.e2e_budget_topic.json, "budgets.amazonaws.com")
    error_message = "the e2e budget SNS topic policy must allow budgets.amazonaws.com to publish."
  }
}
