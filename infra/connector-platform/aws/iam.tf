# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The platform AWS identity Alethia's control plane authenticates as. The whole managed-cloud model
# hubs through it: the console/runner use its static key to sts:AssumeRole into the customer's
# cross-account provisioner role (AWS), and google-auth uses the SAME key as the subject-token source
# for GCP Workload Identity (the customer WIF pool trusts this account's AWS provider). Apply ONCE with
# an admin identity in the platform account. The access key is created MANUALLY afterwards (see README /
# outputs) so no long-lived secret ever lands in OpenTofu state.

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
}

resource "aws_iam_user" "assumer" {
  name = var.user_name
  tags = local.tags
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
  name        = "${var.user_name}-assume-role"
  description = "Allow the Alethia platform assumer to AssumeRole into customer provisioner roles (ExternalId-gated)."
  policy      = data.aws_iam_policy_document.assume_customer_roles.json
  tags        = local.tags
}

resource "aws_iam_user_policy_attachment" "assumer" {
  user       = aws_iam_user.assumer.name
  policy_arn = aws_iam_policy.assume_customer_roles.arn
}
