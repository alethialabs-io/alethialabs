# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# BYOC A1.1 — the `alethia-e2e-nightly` OIDC role: the identity the T2 real-cloud nightly
# (.github/workflows/e2e-nightly.yml) assumes to provision + tear down a genuine, ephemeral
# AWS EKS cluster from infra/templates/project/aws (EKS + VPC + RDS + ElastiCache + ECR +
# IRSA + Karpenter + …).
#
# A provisioning identity is inherently broad — you cannot enumerate a least-privilege
# action list for "stand up + tear down a whole EKS estate" without it breaking on the next
# template change. So the security model here is DEFENSE BY GUARDRAIL, not by a narrow
# allow-list. Three independent walls cap the blast radius:
#
#   1. A ref-bound OIDC trust  — only Actions runs on `refs/heads/<e2e_github_branch>`
#      (StringEquals, never StringLike) can assume it. PRs, forks, and other branches cannot.
#   2. A permissions boundary  — an un-removable ceiling (this role is DENIED the IAM calls
#      that would let it edit its own boundary/trust) that strips out: any region but
#      `e2e_region`, the prod tofu-state bucket, the prod secret vault, self-tamper on the
#      `/alethia-e2e/` guardrail entities, admin-policy attachment (escalation), and org/account.
#   3. A monthly Budget + SNS  — a cost kill-signal (see e2e-budget.tf).
#
# All IAM entities this role family creates are path-scoped under `/alethia-e2e/` so the
# boundary's self-tamper deny can target them precisely and so they are trivially auditable.
# Applied by the maintainer with an admin identity (invariant 4: `tofu apply` on infra/ IAM
# stacks is maintainer-only). Agents never apply.

locals {
  # IAM entities this stack's e2e family owns live under this path — the boundary's
  # self-protection deny is scoped to it.
  e2e_path = "/alethia-e2e/"

  # The EXACT OIDC subjects allowed to assume the role. `schedule` runs on the default
  # branch (main); a `workflow_dispatch` from that branch mints the same ref sub. Optionally
  # also trust a branch-restricted GitHub environment. StringEquals over this list is an OR of
  # EXACT strings — no `*`, no StringLike, so no sibling repo / branch / PR / fork can match.
  e2e_subs = concat(
    ["repo:${var.github_repo}:ref:refs/heads/${var.e2e_github_branch}"],
    var.e2e_github_environment != "" ? ["repo:${var.github_repo}:environment:${var.e2e_github_environment}"] : [],
  )

  # Truly global / us-east-1-homed services that are region-less by nature — carved out of
  # the region-deny so the lock doesn't spuriously block IAM/STS/Route53/CloudFront/WAF-global/
  # Budgets/Organizations. (resourcegroupstaggingapi `tag:*` is regional and used by the
  # cleanup IN e2e_region, so it is deliberately NOT carved out.)
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
}

# ── Trust: GitHub OIDC, ref-bound, plus the optional local-apply admin escape hatch ──
data "aws_iam_policy_document" "e2e_nightly_trust" {
  statement {
    sid     = "GithubOIDCNightly"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }
    # Audience must be the AWS STS audience — blocks a token minted for another audience.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # EXACT subject match — the ref binding. Never StringLike (no ref wildcards).
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.e2e_subs
    }
  }

  # Optional: let an admin principal assume the role for a local apply/import/debug. Empty
  # admin_principal_arns (the default) ⇒ OIDC-only, no human assume path.
  dynamic "statement" {
    for_each = length(var.admin_principal_arns) > 0 ? [1] : []
    content {
      sid     = "AdminAssume"
      effect  = "Allow"
      actions = ["sts:AssumeRole"]
      principals {
        type        = "AWS"
        identifiers = var.admin_principal_arns
      }
    }
  }
}

# ── Permissions boundary: the un-removable ceiling ───────────────────────────
# A boundary caps the role's EFFECTIVE permissions to the intersection of (identity policy)
# and (this boundary). We allow `*` here and rely on explicit Denies for the guardrails — the
# identity policy (below) is the real allow-list, this is the wall it can never punch through.
data "aws_iam_policy_document" "e2e_boundary" {
  statement {
    sid       = "CeilingAllowAll"
    effect    = "Allow"
    actions   = ["*"]
    resources = ["*"]
  }

  # (1) Region lock — deny every action outside e2e_region, except the region-less globals.
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

  # (2) Protect the prod OpenTofu state bucket — the e2e role can never read/write/delete it.
  statement {
    sid     = "DenyProdTofuState"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      "arn:aws:s3:::${var.state_bucket_name}",
      "arn:aws:s3:::${var.state_bucket_name}/*",
    ]
  }

  # (3) Protect the prod secret vault. The trailing `*` absorbs Secrets Manager's random 6-char
  #     ARN suffix on `${var.prod_env_secret_name}` (it does NOT broaden to unrelated secrets).
  statement {
    sid       = "DenyProdSecrets"
    effect    = "Deny"
    actions   = ["secretsmanager:*"]
    resources = ["arn:aws:secretsmanager:*:${local.account_id}:secret:${var.prod_env_secret_name}*"]
  }

  # (4) Self-tamper deny — the role may not rewrite its own boundary/trust/policies, i.e. any
  #     IAM entity under /alethia-e2e/. This is what makes the boundary UN-REMOVABLE.
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
      "arn:aws:iam::${local.account_id}:role/alethia-e2e/*",
      "arn:aws:iam::${local.account_id}:policy/alethia-e2e/*",
    ]
  }

  # (5) Escalation deny — never attach an AWS-managed admin/*-full policy to ANY principal.
  #     The provision only ever attaches scoped service policies (EKS CNI, CloudWatch, …), so
  #     this blocks the classic "create a role, attach AdministratorAccess" escape without
  #     touching a legitimate provision.
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

  # (6) Deny org/account-level reach entirely (never needed to provision a cluster).
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

  # (7) Role-hop friction. Denying sts:AssumeRole removes the SIMPLEST "create an unconstrained
  #     role, then jump to it" escape. It is NOT full containment, and deliberately does not claim
  #     to be: the role legitimately mints IAM principals for the cluster (IRSA roles, the sqs
  #     aws_iam_user + access key), so with iam:* + iam:PassRole + a compute service it can still
  #     escape a boundary that only binds THIS role — e.g. CreateUser + inline PutUserPolicy *:* +
  #     CreateAccessKey, or CreateRole + PassRole to an EC2 instance profile. A permissions boundary
  #     fundamentally cannot contain a principal that can create *other* unbounded principals.
  #     TRUE containment needs either a per-created-entity boundary requirement wired into the
  #     template (BYOC A1.2) or — cleaner — a DEDICATED e2e AWS account (recommended; mirrors the
  #     invariant-3 Hetzner decision). Until then the real wall is the ref-bound OIDC trust: only
  #     trusted-branch runs execute here, so "who can run the nightly" == "who has latent account
  #     admin". See the README "known limitation" note.
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
  description = "Permissions boundary capping the e2e-nightly role: region lock + prod-resource isolation + no self-tamper / escalation / org access."
  policy      = data.aws_iam_policy_document.e2e_boundary.json
  tags        = local.tags
}

# ── Identity policy: broad provisioning reach for the AWS project template ────
# The real allow-list. Service-level for the estate infra/templates/project/aws stands up
# and destroys; capped by the boundary above (region, prod isolation, escalation) and the
# region-deny repeated here for defence in depth.
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
    # NB: `sts:AssumeRole` is deliberately NOT granted — the AWS template's providers operate
    # directly (no `assume_role` block), so the role never role-hops. With the boundary's DenyRoleHop
    # this removes the SIMPLEST create-role-then-jump escape (see DenyRoleHop for why it isn't a full
    # containment guarantee).
  }

  # Teardown discovery + label sweep: the nightly cleanup (BYOC A1.3) uses
  # resourcegroupstaggingapi to find + verify every resource tagged for this run.
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

  # Defence in depth: the region lock is ALSO expressed on the identity policy, so even a
  # future widening of the actions above can't leave e2e_region. (The boundary is the
  # authoritative, un-removable copy.)
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

# ── The role ─────────────────────────────────────────────────────────────────
resource "aws_iam_role" "e2e_nightly" {
  name                 = "alethia-e2e-nightly"
  path                 = local.e2e_path
  description          = "OIDC role for the T2 real-cloud nightly — provisions + tears down an ephemeral AWS EKS cluster. Boundary + region-lock + budget capped. See infra/aws-oidc/e2e-nightly.tf."
  assume_role_policy   = data.aws_iam_policy_document.e2e_nightly_trust.json
  permissions_boundary = aws_iam_policy.e2e_boundary.arn
  # A long EKS+Karpenter apply must outlive the default 1h session; 2h headroom under the
  # workflow's 60m job cap. The workflow requests the duration it needs at assume time.
  max_session_duration = 7200
  tags                 = local.tags
}

resource "aws_iam_role_policy" "e2e_nightly" {
  name   = "alethia-e2e-nightly-provision"
  role   = aws_iam_role.e2e_nightly.id
  policy = data.aws_iam_policy_document.e2e_nightly.json
}
