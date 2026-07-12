variable "issuer_url" {
  type        = string
  default     = "https://alethialabs.io/api/oidc"
  description = "The Alethia control-plane OIDC issuer this account trusts. Override only for a self-hosted Alethia."
}

variable "issuer_audience" {
  type        = string
  default     = "sts.amazonaws.com"
  description = "The audience the minted assertion carries (pinned in the trust policy). Do not change."
}

variable "workload_subject" {
  type        = string
  default     = "alethia-connector"
  description = "The fixed workload subject Alethia mints (pinned in the trust policy). Do not change."
}

variable "role_name" {
  type        = string
  default     = "AlethiaProvisionerRole"
  description = "The name of the IAM role to be created."
}

locals {
  # The OIDC condition keys AWS derives from the provider URL (scheme stripped).
  oidc_host = replace(var.issuer_url, "https://", "")
}

# The Alethia issuer as an IAM OIDC identity provider. AWS validates each assertion's signature against the
# issuer's published JWKS; the thumbprint is required by the API but no longer used for a well-known-CA
# issuer, so we derive it from the live TLS chain rather than hand-maintaining it.
data "tls_certificate" "issuer" {
  url = var.issuer_url
}

resource "aws_iam_openid_connect_provider" "alethia" {
  url             = var.issuer_url
  client_id_list  = [var.issuer_audience]
  thumbprint_list = [data.tls_certificate.issuer.certificates[length(data.tls_certificate.issuer.certificates) - 1].sha1_fingerprint]
}

# Trust ONLY Alethia's issuer, pinned to the fixed workload subject + audience the console mints — no
# external id, no trust in an Alethia AWS account. A wrong sub/aud is rejected.
data "aws_iam_policy_document" "trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.alethia.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = [var.issuer_audience]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = [var.workload_subject]
    }
  }
}

resource "aws_iam_role" "alethia_role" {
  name               = var.role_name
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

data "aws_caller_identity" "current" {}

# ─────────────────────────────────────────────────────────────────────────────
# Least-privilege provisioning policy (replaces AdministratorAccess).
#
# Scoped to EXACTLY the services Alethia's project templates create — no more.
# Data-plane services are service-scoped (e.g. ec2:*, rds:*); the IAM block is
# action-enumerated (that is where escalation risk lives) and explicitly DENIES
# attaching admin-grade managed policies to any role/user it creates. A fresh
# Project uses a subset of these services, gated by feature toggles.
#
# What is NOT here (and thus denied): organizations:*, account:*, billing, and
# any service Alethia does not provision. Attach a tighter policy if you run a
# narrower set of Projects — the OIDC trust above is independent of this.
# ─────────────────────────────────────────────────────────────────────────────

# Compute + cluster + networking + scaling.
data "aws_iam_policy_document" "compute" {
  statement {
    sid    = "ComputeClusterNetworkScaling"
    effect = "Allow"
    actions = [
      "ec2:*", "eks:*", "autoscaling:*", "application-autoscaling:*",
      "elasticloadbalancing:*", "events:*", "cloudwatch:*", "pricing:GetProducts",
      "tag:GetResources", "tag:GetTagKeys", "tag:GetTagValues",
    ]
    resources = ["*"]
  }
}

# Data stores + secrets + encryption + messaging + registry + object storage.
data "aws_iam_policy_document" "data" {
  statement {
    sid    = "DataSecretsMessagingRegistry"
    effect = "Allow"
    actions = [
      "rds:*", "elasticache:*", "dynamodb:*", "s3:*", "ecr:*",
      "secretsmanager:*", "kms:*", "sqs:*", "sns:*", "ssm:*",
    ]
    resources = ["*"]
  }
}

# Edge: DNS, certs, WAF, logs + log-delivery.
data "aws_iam_policy_document" "edge" {
  statement {
    sid    = "DnsCertsWafLogs"
    effect = "Allow"
    actions = [
      "route53:*", "route53domains:ListDomains", "acm:*", "wafv2:*",
      "logs:*", "firehose:*",
    ]
    resources = ["*"]
  }
}

# IAM — action-enumerated (the escalation-sensitive surface). Lets the templates
# create the EKS cluster/node roles, IRSA roles, the OIDC provider, instance
# profiles, and (legacy) service users — but PassRole is restricted to the cloud
# services that consume these roles, and attaching Administrator/PowerUser/
# IAMFullAccess to any created principal is explicitly DENIED (closes the
# create-role-then-grant-admin escalation).
data "aws_iam_policy_document" "iam" {
  statement {
    sid    = "IamManageProvisionedPrincipals"
    effect = "Allow"
    actions = [
      "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole",
      "iam:TagRole", "iam:UntagRole", "iam:UpdateAssumeRolePolicy",
      "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy",
      "iam:AttachRolePolicy", "iam:DetachRolePolicy",
      "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListRoleTags",
      "iam:CreatePolicy", "iam:DeletePolicy", "iam:GetPolicy",
      "iam:CreatePolicyVersion", "iam:DeletePolicyVersion",
      "iam:GetPolicyVersion", "iam:ListPolicyVersions", "iam:ListPolicies",
      "iam:CreateInstanceProfile", "iam:DeleteInstanceProfile",
      "iam:GetInstanceProfile", "iam:AddRoleToInstanceProfile",
      "iam:RemoveRoleFromInstanceProfile", "iam:TagInstanceProfile",
      "iam:CreateOpenIDConnectProvider", "iam:DeleteOpenIDConnectProvider",
      "iam:GetOpenIDConnectProvider", "iam:TagOpenIDConnectProvider",
      "iam:UpdateOpenIDConnectProviderThumbprint",
      "iam:AddClientIDToOpenIDConnectProvider",
      "iam:CreateUser", "iam:DeleteUser", "iam:GetUser", "iam:TagUser",
      "iam:PutUserPolicy", "iam:DeleteUserPolicy", "iam:GetUserPolicy",
      "iam:ListUserPolicies", "iam:AttachUserPolicy", "iam:DetachUserPolicy",
      "iam:CreateAccessKey", "iam:DeleteAccessKey", "iam:ListAccessKeys",
      "iam:GetRolePolicy", "iam:ListInstanceProfilesForRole",
    ]
    resources = ["*"]
  }
  statement {
    sid       = "PassRoleToProvisionedServices"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values = [
        "eks.amazonaws.com", "ec2.amazonaws.com", "rds.amazonaws.com",
        "monitoring.rds.amazonaws.com", "elasticache.amazonaws.com",
        "firehose.amazonaws.com", "application-autoscaling.amazonaws.com",
      ]
    }
  }
  statement {
    sid       = "CreateServiceLinkedRolesForProvisionedServices"
    effect    = "Allow"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values = [
        "eks.amazonaws.com", "eks-nodegroup.amazonaws.com",
        "spot.amazonaws.com", "elasticache.amazonaws.com",
        "rds.amazonaws.com", "elasticloadbalancing.amazonaws.com",
      ]
    }
  }
  # The keystone: never let the connector attach admin-grade managed policies to
  # anything it creates (or to itself). This closes the CreateRole → AttachAdmin
  # → assume path even though iam:CreateRole is granted above.
  statement {
    sid    = "DenyAttachAdminGradePolicies"
    effect = "Deny"
    actions = [
      "iam:AttachRolePolicy", "iam:AttachUserPolicy",
      "iam:PutRolePolicy", "iam:PutUserPolicy",
    ]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values = [
        "arn:aws:iam::aws:policy/AdministratorAccess",
        "arn:aws:iam::aws:policy/IAMFullAccess",
        "arn:aws:iam::aws:policy/PowerUserAccess",
      ]
    }
  }
  # Belt-and-suspenders: no path back to account-wide privilege.
  statement {
    sid       = "DenyOrgAndAccountControl"
    effect    = "Deny"
    actions   = ["organizations:*", "account:*", "iam:CreateAccountAlias", "iam:DeleteAccountAlias"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "compute" {
  name   = "${var.role_name}-Compute"
  policy = data.aws_iam_policy_document.compute.json
}

resource "aws_iam_policy" "data" {
  name   = "${var.role_name}-Data"
  policy = data.aws_iam_policy_document.data.json
}

resource "aws_iam_policy" "edge" {
  name   = "${var.role_name}-Edge"
  policy = data.aws_iam_policy_document.edge.json
}

resource "aws_iam_policy" "iam" {
  name   = "${var.role_name}-IAM"
  policy = data.aws_iam_policy_document.iam.json
}

resource "aws_iam_role_policy_attachment" "scoped" {
  for_each = {
    compute = aws_iam_policy.compute.arn
    data    = aws_iam_policy.data.arn
    edge    = aws_iam_policy.edge.arn
    iam     = aws_iam_policy.iam.arn
  }
  role       = aws_iam_role.alethia_role.name
  policy_arn = each.value
}

output "role_arn" {
  value       = aws_iam_role.alethia_role.arn
  description = "The ARN of the created role. Copy this back into the Alethia dashboard."
}
