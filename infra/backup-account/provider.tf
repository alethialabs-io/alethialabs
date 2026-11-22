# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Every resource in this stack lands in the dedicated `alethia-backup` account. The base credentials
# are the maintainer's Alethia SSO session (the same ones the S3 backend uses); the provider assumes
# the admin role infra/backup-account/bootstrap created in the backup account. The same shape as
# infra/email-ses-account/provider.tf.
#
# `allowed_account_ids` is the load-bearing line. If the assumed role ever resolves to any other
# account — the Alethia platform account that holds prod included — the provider REFUSES before it
# reads or writes anything.

provider "aws" {
  region = var.backup_region

  assume_role {
    role_arn     = "arn:aws:iam::${var.backup_account_id}:role/${var.backup_admin_role_name}"
    session_name = "alethia-backup-apply"
  }

  allowed_account_ids = [var.backup_account_id]

  default_tags {
    tags = {
      project = "alethia"
      role    = "backup-account"
      managed = "opentofu"
    }
  }
}

data "aws_caller_identity" "current" {}
