# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# `alethia-e2e-nightly`, re-homed in the dedicated e2e account. The SAME role name, path, trust
# subjects, boundary and identity policy as infra/aws-oidc/e2e-nightly.tf — so a run that assumes
# this one behaves exactly like a run that assumed the old one — with three deliberate differences:
#
#   1. It lives in an account that holds NO prod resource. infra/aws-oidc's own DenyRoleHop comment
#      states the limit of a permissions boundary: a role that can create OTHER unbounded principals
#      (iam:* + PassRole) can escape a boundary that binds only itself, and recommends "a DEDICATED
#      e2e AWS account". This stack is that account. The prod denies below are kept as defence in
#      depth, but the wall is now the account boundary: nothing in the Alethia platform account
#      trusts this account, and the state bucket and vault live there.
#   2. It cannot touch the ways back in: the admin role the maintainer applies through, the
#      Organizations access role, the two OIDC providers its own trust names, and the budget topic
#      (DenyTamperWithBreakGlass). In the shared account there was nothing equivalent to protect.
#   3. No human AdminAssume statement on the trust. The maintainer reaches this account through
#      `alethia-e2e-admin` (bootstrap/), so the nightly role is federation-only.
#
# Applied by the maintainer only (invariant 4). Agents never apply.

locals {
  e2e_path = "/alethia-e2e/"

  # Exact subjects, StringEquals over the list (an OR of exact strings, never StringLike): the ref
  # the scheduled run presents, and the branch-restricted environment a dispatch from `dev` presents.
  e2e_subs = [
    "repo:${var.github_repo}:ref:refs/heads/${var.e2e_github_branch}",
    "repo:${var.github_repo}:environment:${var.e2e_github_environment}",
  ]

  # Region-less services carved out of the region lock (identical to infra/aws-oidc).
  e2e_global_services = [
    "iam:*",
    "sts:*",
    "organizations:*",
    "account:*",
    "support:*",
    "route53:*",
    "route53domains:*",
    "cloudfront:*",
    "waf:*",
    "wafv2:*",
    "globalaccelerator:*",
    "budgets:*",
    "ce:*",
    "cur:*",
    "s3:ListAllMyBuckets",
    "s3:GetAccountPublicAccessBlock",
  ]

  # The ways back into this account, and the trust anchors of the role itself. Built from plan-time
  # values so the boundary renders in full on the first plan.
  break_glass_role_arns = [
    "arn:aws:iam::${var.e2e_account_id}:role/${var.e2e_admin_role_name}",
    "arn:aws:iam::${var.e2e_account_id}:role/OrganizationAccountAccessRole",
  ]
  trust_anchor_provider_arns = compact([
    local.github_oidc_provider_arn,
    local.broker_provider_arn,
  ])
  budget_topic_name = "alethia-e2e-nightly-budget-alerts"
  budget_topic_arn  = "arn:aws:sns:us-east-1:${var.e2e_account_id}:${local.budget_topic_name}"
}

# ── Trust: GitHub OIDC (exact subjects) + the optional broker statement ──────────────────────────
data "aws_iam_policy_document" "e2e_nightly_trust" {
  statement {
    sid     = "GithubOIDCNightly"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:sub"
      values   = local.e2e_subs
    }
  }

  # #4226 — the E2E assertion broker, a SECOND issuer. Rendered only when e2e_broker_issuer_url is
  # set; e2e-broker.tf says what it pins and why that is all IAM can pin.
  dynamic "statement" {
    for_each = local.broker_enabled ? [1] : []
    content {
      sid     = "E2EBrokerAssertion"
      effect  = "Allow"
      actions = ["sts:AssumeRoleWithWebIdentity"]
      principals {
        type        = "Federated"
        identifiers = [local.broker_provider_arn]
      }
      condition {
        test     = "StringEquals"
        variable = "${local.broker_issuer_host}:aud"
        values   = [local.broker_audience]
      }
      condition {
        test     = "StringEquals"
        variable = "${local.broker_issuer_host}:sub"
        values   = [local.broker_subject]
      }
    }
  }
}

# ── Permissions boundary ─────────────────────────────────────────────────────────────────────────
data "aws_iam_policy_document" "e2e_boundary" {
  statement {
    sid       = "CeilingAllowAll"
    effect    = "Allow"
    actions   = ["*"]
    resources = ["*"]
  }

  # (1) Region lock.
  statement {
    sid         = "DenyOutsideE2ERegion"
    effect      = "Deny"
    not_actions = local.e2e_global_services
    resources   = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestedRegion"
      values   = [var.e2e_region]
    }
  }

  # (2) The prod state bucket. It is in ANOTHER account and grants this one nothing, so this deny is
  #     defence in depth rather than the wall — kept so a future bucket-policy mistake is still capped.
  statement {
    sid     = "DenyProdTofuState"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      "arn:aws:s3:::${var.state_bucket_name}",
      "arn:aws:s3:::${var.state_bucket_name}/*",
    ]
  }

  # (3) The prod vault, by its ARN in the Alethia platform account (again defence in depth).
  statement {
    sid       = "DenyProdSecrets"
    effect    = "Deny"
    actions   = ["secretsmanager:*"]
    resources = ["arn:aws:secretsmanager:*:${var.alethia_account_id}:secret:${var.prod_env_secret_name}*"]
  }

  # (4) Self-tamper: no edit of any IAM entity under /alethia-e2e/ — what makes the boundary
  #     un-removable.
  statement {
    sid    = "DenyTamperWithGuardrails"
    effect = "Deny"
    actions = [
      "iam:PutRolePermissionsBoundary",
      "iam:DeleteRolePermissionsBoundary",
      "iam:PutUserPermissionsBoundary",
      "iam:DeleteUserPermissionsBoundary",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
      "iam:DeleteRole",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:SetDefaultPolicyVersion",
      "iam:DeletePolicy",
    ]
    resources = [
      "arn:aws:iam::${var.e2e_account_id}:role/alethia-e2e/*",
      "arn:aws:iam::${var.e2e_account_id}:policy/alethia-e2e/*",
    ]
  }

  # (4b) NEW in the dedicated account: the ways back in. With iam:* the role could otherwise rewrite
  #      the trust of the maintainer's apply role or of OrganizationAccountAccessRole (locking the
  #      maintainer out of the account it is running up a bill in), or edit the OIDC providers its own
  #      trust names, or unsubscribe the budget alerts. None of that is needed to provision a cluster.
  statement {
    sid    = "DenyTamperWithBreakGlass"
    effect = "Deny"
    actions = [
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
      "iam:DeleteRole",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePermissionsBoundary",
      "iam:DeleteRolePermissionsBoundary",
      "iam:TagRole",
      "iam:UntagRole",
    ]
    resources = local.break_glass_role_arns
  }

  statement {
    sid    = "DenyTamperWithTrustAnchors"
    effect = "Deny"
    actions = [
      "iam:DeleteOpenIDConnectProvider",
      "iam:UpdateOpenIDConnectProviderThumbprint",
      "iam:AddClientIDToOpenIDConnectProvider",
      "iam:RemoveClientIDFromOpenIDConnectProvider",
      "iam:TagOpenIDConnectProvider",
      "iam:UntagOpenIDConnectProvider",
    ]
    resources = local.trust_anchor_provider_arns
  }

  statement {
    sid    = "DenyTamperWithCostGuard"
    effect = "Deny"
    actions = [
      "sns:DeleteTopic",
      "sns:SetTopicAttributes",
      "sns:AddPermission",
      "sns:RemovePermission",
      "sns:Subscribe",
      "sns:Unsubscribe",
    ]
    resources = [local.budget_topic_arn]
  }

  # (5) Escalation: never attach an AWS-managed admin policy to any principal.
  statement {
    sid    = "DenyAdminPolicyAttach"
    effect = "Deny"
    actions = [
      "iam:AttachRolePolicy",
      "iam:AttachUserPolicy",
      "iam:AttachGroupPolicy",
    ]
    resources = ["*"]
    condition {
      test     = "ArnLike"
      variable = "iam:PolicyARN"
      values = [
        "arn:aws:iam::aws:policy/AdministratorAccess",
        "arn:aws:iam::aws:policy/IAMFullAccess",
        "arn:aws:iam::aws:policy/PowerUserAccess",
      ]
    }
  }

  # (6) No org/account-level reach (also blocks LeaveOrganization from inside the member).
  statement {
    sid    = "DenyOrgAndAccount"
    effect = "Deny"
    actions = [
      "organizations:*",
      "account:*",
      "iam:CreateAccountAlias",
      "iam:DeleteAccountAlias",
    ]
    resources = ["*"]
  }

  # (7) Role-hop friction (see infra/aws-oidc/e2e-nightly.tf for why this is friction, not
  #     containment). Also means the nightly role cannot assume alethia-e2e-admin even if its trust
  #     were widened.
  statement {
    sid       = "DenyRoleHop"
    effect    = "Deny"
    actions   = ["sts:AssumeRole"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "e2e_boundary" {
  name        = "alethia-e2e-nightly-boundary"
  path        = local.e2e_path
  description = "Permissions boundary capping the e2e-nightly role in the dedicated e2e account: region lock + prod isolation + no self-tamper / break-glass tamper / escalation / org access."
  policy      = data.aws_iam_policy_document.e2e_boundary.json
}

# ── Identity policy: identical to infra/aws-oidc's (the template's estate has not changed) ────────
data "aws_iam_policy_document" "e2e_nightly" {
  statement {
    sid    = "ProvisionEksEstate"
    effect = "Allow"
    actions = [
      "ec2:*",
      "eks:*",
      "rds:*",
      "elasticache:*",
      "ecr:*",
      "ecr-public:*",
      "dynamodb:*",
      "sqs:*",
      "sns:*",
      "kms:*",
      "acm:*",
      "route53:*",
      "wafv2:*",
      "firehose:*",
      "kinesis:*",
      "logs:*",
      "cloudwatch:*",
      "events:*",
      "autoscaling:*",
      "application-autoscaling:*",
      "elasticloadbalancing:*",
      "secretsmanager:*",
      "s3:*",
      "iam:*",
      "servicequotas:Get*",
      "servicequotas:List*",
      "sts:GetCallerIdentity",
    ]
    resources = ["*"]
  }

  # BYO-IaC drift probe (the customer's module writes one SSM parameter). Narrowest ARN in the file.
  statement {
    sid    = "ByoIacProbeParameters"
    effect = "Allow"
    actions = [
      "ssm:PutParameter",
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:DeleteParameter",
      "ssm:ListTagsForResource",
      "ssm:AddTagsToResource",
      "ssm:RemoveTagsFromResource",
    ]
    resources = ["arn:aws:ssm:${var.e2e_region}:${var.e2e_account_id}:parameter/alethia/byo-iac/*"]
  }

  statement {
    sid       = "ByoIacProbeDescribe"
    effect    = "Allow"
    actions   = ["ssm:DescribeParameters"]
    resources = ["*"]
  }

  # Teardown discovery + label sweep (scripts/e2e/aws-cleanup.sh).
  statement {
    sid    = "TeardownTagDiscovery"
    effect = "Allow"
    actions = [
      "tag:GetResources",
      "tag:GetTagKeys",
      "tag:GetTagValues",
      "tag:TagResources",
      "tag:UntagResources",
    ]
    resources = ["*"]
  }

  statement {
    sid         = "DenyOutsideE2ERegion"
    effect      = "Deny"
    not_actions = local.e2e_global_services
    resources   = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestedRegion"
      values   = [var.e2e_region]
    }
  }
}

resource "aws_iam_role" "e2e_nightly" {
  name                 = "alethia-e2e-nightly"
  path                 = local.e2e_path
  description          = "OIDC role for the T2 real-cloud nightly in the dedicated e2e account. Boundary + region-lock + budget capped. See infra/aws-e2e/e2e-nightly.tf."
  assume_role_policy   = data.aws_iam_policy_document.e2e_nightly_trust.json
  permissions_boundary = aws_iam_policy.e2e_boundary.arn
  max_session_duration = 7200

  # The trust names both providers by BUILT ARNs, which carry no dependency edge. These order the
  # providers' creation before the trust that names them, and their removal after.
  depends_on = [
    aws_iam_openid_connect_provider.github,
    aws_iam_openid_connect_provider.e2e_broker,
  ]

  lifecycle {
    # A refusal, not a warning: the provider's allowed_account_ids already pins the account, and this
    # makes the "not the prod account" half explicit at plan.
    precondition {
      condition     = var.e2e_account_id != var.alethia_account_id
      error_message = "e2e_account_id equals alethia_account_id — this stack exists to put the e2e role in a DIFFERENT account from prod."
    }
  }
}

resource "aws_iam_role_policy" "e2e_nightly" {
  name   = "alethia-e2e-nightly-provision"
  role   = aws_iam_role.e2e_nightly.id
  policy = data.aws_iam_policy_document.e2e_nightly.json
}
