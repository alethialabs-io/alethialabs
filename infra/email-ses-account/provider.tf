# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Every resource in this stack lands in the dedicated `alethia-email` account. The base credentials
# are the maintainer's Alethia SSO session (the same ones the S3 backend uses); the provider assumes
# the admin role infra/email-ses-account/bootstrap created in the email account. The same shape as
# infra/aws-e2e/provider.tf.
#
# `allowed_account_ids` is the load-bearing line. If the assumed role ever resolves to any other
# account — the Alethia platform account that holds prod included — the provider REFUSES before it
# reads or writes anything. A misconfigured role name fails at assume; a role that exists in the
# wrong account fails here.

provider "aws" {
  region = var.email_region

  assume_role {
    role_arn     = "arn:aws:iam::${var.email_account_id}:role/${var.email_admin_role_name}"
    session_name = "alethia-email-ses-apply"
  }

  allowed_account_ids = [var.email_account_id]

  default_tags {
    tags = {
      project = "alethia"
      role    = "email-ses-account"
      managed = "opentofu"
    }
  }
}

data "aws_caller_identity" "current" {}
