# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Every resource in this stack lands in the dedicated `alethia-e2e` account. The base credentials are
# the maintainer's Alethia SSO session (the same ones the S3 backend uses); the provider assumes the
# admin role infra/aws-e2e/bootstrap created in the e2e account.
#
# `allowed_account_ids` is the load-bearing line. If the assumed role ever resolves to any other
# account — the Alethia platform account that holds prod included — the provider REFUSES before it
# reads or writes anything. A misconfigured role name fails at assume; a role that exists in the
# wrong account fails here.

locals {
  provider_assume_role_arn = "arn:aws:iam::${var.e2e_account_id}:role/${var.e2e_admin_role_name}"
  provider_default_tags = {
    project = "alethia"
    role    = "aws-e2e"
    managed = "opentofu"
  }
}

provider "aws" {
  region = var.e2e_region

  assume_role {
    role_arn     = local.provider_assume_role_arn
    session_name = "alethia-aws-e2e-apply"
  }

  allowed_account_ids = [var.e2e_account_id]

  default_tags {
    tags = local.provider_default_tags
  }
}

# AWS Budgets is homed in us-east-1 and can publish only to a us-east-1 SNS topic, so the cost guard
# is pinned there regardless of e2e_region (the same split as infra/aws-oidc's `aws.useast1`).
provider "aws" {
  alias  = "useast1"
  region = "us-east-1"

  assume_role {
    role_arn     = local.provider_assume_role_arn
    session_name = "alethia-aws-e2e-apply"
  }

  allowed_account_ids = [var.e2e_account_id]

  default_tags {
    tags = local.provider_default_tags
  }
}

data "aws_caller_identity" "current" {}
