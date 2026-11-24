# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Every resource in this stack lands in the existing `alethia-backup` account (decision F6 in the
# books-automation plan: reuse it rather than open another account). The base credentials are the
# maintainer's Alethia SSO session (the same ones the S3 backend uses); the provider assumes the admin
# role infra/backup-account/bootstrap created there. The same shape as infra/backup-account.
#
# `allowed_account_ids` is the load-bearing line: if the assumed role ever resolves to any other
# account — the Alethia platform account that holds prod included — the provider REFUSES before it
# reads or writes anything.

provider "aws" {
  region = var.region

  assume_role {
    role_arn     = "arn:aws:iam::${var.backup_account_id}:role/${var.backup_admin_role_name}"
    session_name = "alethia-books-archive-apply"
  }

  allowed_account_ids = [var.backup_account_id]

  default_tags {
    tags = {
      project = "alethia"
      # Also the budget's cost filter (budget.tf): `role` must be an ACTIVE cost allocation tag.
      role    = local.cost_tag_value
      managed = "opentofu"
    }
  }
}

data "aws_caller_identity" "current" {}
