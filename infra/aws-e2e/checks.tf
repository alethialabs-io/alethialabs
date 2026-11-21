# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Loud invariant assertions, ported from infra/aws-oidc/checks.tf plus the ones the dedicated account
# adds. A `check` block WARNS: `tofu plan` still exits 0 with the message printed. The properties that
# must be UN-APPLIABLE rather than noisy are enforced elsewhere and say so: the account pin is the
# provider's allowed_account_ids, the not-prod-account rule is a precondition on the role, the zone's
# survival is prevent_destroy. checks.tftest.hcl proves each check here can fire.

# ── The account ──────────────────────────────────────────────────────────────────────────────────
check "e2e_account_is_the_dedicated_one" {
  assert {
    condition = alltrue([
      data.aws_caller_identity.current.account_id == var.e2e_account_id,
      data.aws_caller_identity.current.account_id != var.alethia_account_id,
    ])
    error_message = "the provider is operating in ${data.aws_caller_identity.current.account_id}, not the dedicated e2e account ${var.e2e_account_id} (or that is the Alethia platform account)."
  }
}

# ── Trust: exact subjects, StringEquals, pinned audience ─────────────────────────────────────────
check "e2e_trust_is_ref_bound" {
  assert {
    condition = alltrue([
      for s in local.e2e_subs :
      can(regex("^repo:[^:*]+/[^:*]+:(ref:refs/heads/[^:*]+|environment:[^:*]+)$", s))
    ])
    error_message = "e2e OIDC subjects must be EXACT repo:<owner>/<repo>:ref:refs/heads/<branch> or :environment:<env> with no '*' — got ${jsonencode(local.e2e_subs)}."
  }
}

check "e2e_trust_uses_string_equals_and_aud" {
  assert {
    condition = alltrue([
      strcontains(data.aws_iam_policy_document.e2e_nightly_trust.json, "sts.amazonaws.com"),
      strcontains(data.aws_iam_policy_document.e2e_nightly_trust.json, "token.actions.githubusercontent.com:sub"),
      !strcontains(data.aws_iam_policy_document.e2e_nightly_trust.json, "StringLike"),
    ])
    error_message = "e2e trust must pin aud=sts.amazonaws.com and match the sub with StringEquals (no StringLike)."
  }
}

check "e2e_trust_is_federation_only" {
  assert {
    # The maintainer reaches this account through alethia-e2e-admin. A plain sts:AssumeRole statement
    # on the nightly role would be a second, unreviewed human path into the broadest role here.
    condition     = !strcontains(data.aws_iam_policy_document.e2e_nightly_trust.json, "\"sts:AssumeRole\"")
    error_message = "the e2e nightly trust must admit only sts:AssumeRoleWithWebIdentity — no AWS-principal AssumeRole statement."
  }
}

check "github_oidc_provider_arn_matches" {
  assert {
    # The trust names the GitHub provider by a BUILT ARN (oidc.tf). On the first plan the right side
    # is unknown, so this reports at apply; on every plan after it, at plan.
    condition     = aws_iam_openid_connect_provider.github.arn == local.github_oidc_provider_arn
    error_message = "the e2e trust names ${local.github_oidc_provider_arn}, but the GitHub OIDC provider's ARN is different — the trust would federate a provider that does not exist."
  }
}

# ── Boundary ─────────────────────────────────────────────────────────────────────────────────────
check "e2e_boundary_attached" {
  assert {
    condition     = aws_iam_role.e2e_nightly.permissions_boundary == aws_iam_policy.e2e_boundary.arn
    error_message = "e2e-nightly role must have the alethia-e2e-nightly-boundary permissions boundary attached."
  }
}

check "e2e_entities_path_scoped" {
  assert {
    condition = alltrue([
      aws_iam_role.e2e_nightly.path == "/alethia-e2e/",
      aws_iam_policy.e2e_boundary.path == "/alethia-e2e/",
      # The path is what puts the reporter under DenyTamperWithGuardrails (spend-reporter.tf).
      aws_iam_role.spend_reporter.path == "/alethia-e2e/",
    ])
    error_message = "e2e IAM roles (nightly, spend reporter) + the boundary policy must be path-scoped under /alethia-e2e/."
  }
}

check "e2e_boundary_region_locked" {
  assert {
    condition = alltrue([
      strcontains(data.aws_iam_policy_document.e2e_boundary.json, "aws:RequestedRegion"),
      strcontains(data.aws_iam_policy_document.e2e_boundary.json, "StringNotEquals"),
      strcontains(data.aws_iam_policy_document.e2e_nightly.json, "aws:RequestedRegion"),
    ])
    error_message = "the region lock (aws:RequestedRegion StringNotEquals) must be in BOTH the boundary and the identity policy."
  }
}

check "e2e_boundary_isolates_prod" {
  assert {
    condition = alltrue([
      # Non-vacuity: strcontains(x, "") is always true.
      var.state_bucket_name != "",
      var.prod_env_secret_name != "",
      strcontains(data.aws_iam_policy_document.e2e_boundary.json, "arn:aws:s3:::${var.state_bucket_name}"),
      strcontains(data.aws_iam_policy_document.e2e_boundary.json, "${var.alethia_account_id}:secret:${var.prod_env_secret_name}"),
    ])
    error_message = "the e2e boundary must deny the (non-empty) prod state bucket and the prod secret in the Alethia platform account."
  }
}

check "e2e_boundary_guardrails_present" {
  assert {
    condition = alltrue([for sid in [
      "DenyTamperWithGuardrails",
      "DenyTamperWithBreakGlass",
      "DenyTamperWithTrustAnchors",
      "DenyTamperWithCostGuard",
      "DenyAdminPolicyAttach",
      "DenyOrgAndAccount",
      "DenyRoleHop",
      "DenyProdTofuState",
      "DenyProdSecrets",
    ] : strcontains(data.aws_iam_policy_document.e2e_boundary.json, "\"${sid}\"")])
    error_message = "the e2e boundary dropped a guardrail statement — every Deny listed in this check must stay."
  }
}

check "e2e_boundary_protects_the_ways_back_in" {
  assert {
    condition = alltrue(concat(
      [for a in local.break_glass_role_arns : strcontains(data.aws_iam_policy_document.e2e_boundary.json, a)],
      [strcontains(data.aws_iam_policy_document.e2e_boundary.json, local.github_oidc_provider_arn)],
      [strcontains(data.aws_iam_policy_document.e2e_boundary.json, local.budget_topic_arn)],
      [aws_sns_topic.e2e_budget.name == local.budget_topic_name],
    ))
    error_message = "the boundary must name the admin role, OrganizationAccountAccessRole, the GitHub OIDC provider and the budget topic it protects — and the topic it names must be the one this stack creates."
  }
}

check "e2e_region_not_prod" {
  assert {
    condition     = !contains(["eu-central-1", "eu-west-1"], var.e2e_region)
    error_message = "e2e_region must not be a prod region (eu-central-1 / eu-west-1)."
  }
}

# ── The spend reporter: one exact environment subject, reads only ────────────────────────────────
check "spend_reporter_trust_is_one_exact_environment_sub" {
  assert {
    condition = alltrue([
      can(regex("^repo:[^:*]+/[^:*]+:environment:[^:*]+$", local.spend_reporter_sub)),
      strcontains(data.aws_iam_policy_document.spend_reporter_trust.json, local.spend_reporter_sub),
      strcontains(data.aws_iam_policy_document.spend_reporter_trust.json, "sts.amazonaws.com"),
      !strcontains(data.aws_iam_policy_document.spend_reporter_trust.json, "StringLike"),
      !strcontains(data.aws_iam_policy_document.spend_reporter_trust.json, ":ref:refs/"),
      !strcontains(data.aws_iam_policy_document.spend_reporter_trust.json, "\"sts:AssumeRole\""),
    ])
    error_message = "alethia-spend-reporter must trust exactly ${local.spend_reporter_sub} (StringEquals, aud=sts.amazonaws.com), federation only, and no ref subject."
  }
}

check "spend_reporter_sub_does_not_reach_the_nightly_role" {
  assert {
    condition     = !strcontains(data.aws_iam_policy_document.e2e_nightly_trust.json, local.spend_reporter_sub)
    error_message = "the ${local.spend_reporter_sub} subject must reach alethia-spend-reporter ONLY - it is a read-only report identity."
  }
}

check "spend_reporter_policy_is_read_only" {
  assert {
    # No secretsmanager:GetSecretValue here, unlike the platform reporter: the SES sender key is read there.
    condition = alltrue([
      for a in flatten([for st in jsondecode(data.aws_iam_policy_document.spend_reporter.json).Statement : flatten([st.Action])]) :
      contains(["ce:GetCostAndUsage", "ce:GetCostForecast", "tag:GetResources"], a)
    ])
    error_message = "the e2e alethia-spend-reporter may hold only ce:GetCostAndUsage, ce:GetCostForecast and tag:GetResources."
  }
}

# ── Cost guard ───────────────────────────────────────────────────────────────────────────────────
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

check "e2e_budget_topic_arn_matches" {
  assert {
    condition     = aws_sns_topic.e2e_budget.arn == local.budget_topic_arn
    error_message = "the budget topic policy and the boundary name ${local.budget_topic_arn}, but the topic created is ${aws_sns_topic.e2e_budget.arn}."
  }
}

# ── DNS ──────────────────────────────────────────────────────────────────────────────────────────
check "e2e_dns_zone_is_public" {
  assert {
    # ACM reads the PUBLIC internet; a private zone (one with vpc associations) cannot validate.
    condition     = length(aws_route53_zone.e2e.vpc) == 0
    error_message = "the e2e cert zone must be PUBLIC — a VPC association makes the cert path unprovable."
  }
}

# ── The broker trust (#4226): exact, additive, absent unless asked for ───────────────────────────
check "e2e_broker_trust_is_exact" {
  assert {
    condition = !local.broker_enabled || alltrue([
      strcontains(data.aws_iam_policy_document.e2e_nightly_trust.json, "E2EBrokerAssertion"),
      strcontains(data.aws_iam_policy_document.e2e_nightly_trust.json, "${local.broker_issuer_host}:aud"),
      strcontains(data.aws_iam_policy_document.e2e_nightly_trust.json, "${local.broker_issuer_host}:sub"),
      local.broker_audience == "sts.amazonaws.com",
      local.broker_subject != "" && !strcontains(local.broker_subject, "*"),
      !strcontains(data.aws_iam_policy_document.e2e_nightly_trust.json, "StringLike"),
    ])
    error_message = "the e2e broker trust must pin ${local.broker_issuer_host}:aud = sts.amazonaws.com and ${local.broker_issuer_host}:sub = '${local.broker_subject}' with StringEquals."
  }
}

check "e2e_broker_trust_is_additive" {
  assert {
    condition = alltrue(concat(
      [strcontains(data.aws_iam_policy_document.e2e_nightly_trust.json, "GithubOIDCNightly")],
      [for s in local.e2e_subs : strcontains(data.aws_iam_policy_document.e2e_nightly_trust.json, s)],
    ))
    error_message = "enabling the e2e broker trust must ADD a statement, never replace GithubOIDCNightly — every subject in ${jsonencode(local.e2e_subs)} must still be trusted."
  }
}

check "e2e_broker_provider_arn_matches" {
  assert {
    condition     = !local.broker_enabled || aws_iam_openid_connect_provider.e2e_broker[0].arn == local.broker_provider_arn
    error_message = "the e2e broker trust names ${local.broker_provider_arn}, but the broker OIDC provider's ARN is different."
  }
}

check "e2e_broker_trust_absent_when_unset" {
  assert {
    condition = local.broker_enabled || alltrue([
      !strcontains(data.aws_iam_policy_document.e2e_nightly_trust.json, "E2EBrokerAssertion"),
      length(aws_iam_openid_connect_provider.e2e_broker) == 0,
    ])
    error_message = "with e2e_broker_issuer_url unset there must be no E2EBrokerAssertion statement and no broker OIDC provider."
  }
}
