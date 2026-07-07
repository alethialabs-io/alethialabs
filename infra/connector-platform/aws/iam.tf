# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The platform AWS identity Alethia's control plane authenticates as — now KEYLESS. Instead of a
# long-lived IAM user + access key, the control plane (which runs off-AWS) federates INTO this account
# via STS AssumeRoleWithWebIdentity, presenting a short-lived assertion minted by Alethia's own OIDC
# issuer. The assumed role then sts:AssumeRole's into the customer's cross-account provisioner role (AWS)
# and is the subject-token source for GCP Workload Identity (the customer WIF pool trusts this account).
# Apply ONCE with an admin identity in the platform account. No secret is ever created or stored.

data "aws_caller_identity" "current" {}

locals {
  tags = {
    project = "alethia"
    role    = "connector-platform-assumer"
    managed = "opentofu"
  }

  # The assumer may assume ONLY roles matching the customer provisioner-role name pattern, in ANY
  # customer account (wildcard account), gated further by the per-connection ExternalId at assume time.
  assume_role_resource = "arn:aws:iam::*:role/${var.customer_role_name_prefix}*"

  # The OIDC condition keys AWS derives from the provider URL (scheme stripped).
  oidc_host = replace(var.oidc_issuer_url, "https://", "")
}

# The Alethia OIDC issuer as an IAM identity provider. AWS validates the assertion's signature against
# the issuer's published JWKS; the thumbprint is required by the API but no longer used for validation
# of well-known-CA issuers — computed from the issuer's TLS chain so there's nothing to hand-maintain.
data "tls_certificate" "issuer" {
  url = var.oidc_issuer_url
}

resource "aws_iam_openid_connect_provider" "alethia" {
  url             = var.oidc_issuer_url
  client_id_list  = [var.oidc_audience]
  thumbprint_list = [data.tls_certificate.issuer.certificates[length(data.tls_certificate.issuer.certificates) - 1].sha1_fingerprint]
  tags            = local.tags
}

# Trust ONLY Alethia's issuer, and only the fixed workload subject + audience the console mints — a
# wrong sub/aud is rejected, so no other identity can assume this role.
data "aws_iam_policy_document" "trust" {
  statement {
    sid     = "AlethiaWebIdentity"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.alethia.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = [var.oidc_audience]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = [var.workload_subject]
    }
  }
}

resource "aws_iam_role" "assumer" {
  name                 = var.role_name
  description          = "Role the Alethia control plane assumes (keyless, via the OIDC issuer) to AssumeRole into customer provisioner roles + federate GCP."
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
  tags                 = local.tags
}

data "aws_iam_policy_document" "assume_customer_roles" {
  statement {
    sid       = "AssumeCustomerProvisionerRoles"
    effect    = "Allow"
    actions   = ["sts:AssumeRole"]
    resources = [local.assume_role_resource]
  }
}

resource "aws_iam_policy" "assume_customer_roles" {
  name        = "${var.role_name}-assume-role"
  description = "Allow the Alethia platform assumer to AssumeRole into customer provisioner roles (ExternalId-gated)."
  policy      = data.aws_iam_policy_document.assume_customer_roles.json
  tags        = local.tags
}

resource "aws_iam_role_policy_attachment" "assumer" {
  role       = aws_iam_role.assumer.name
  policy_arn = aws_iam_policy.assume_customer_roles.arn
}
