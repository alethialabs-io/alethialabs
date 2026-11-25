# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# books-monthly: the identity the private books repository's workflow assumes (daily ledger,
# monthly close). Through the account's EXISTING GitHub OIDC provider, which infra/backup-account
# owns (oidc.tf there) — this stack reads it and never creates a second one (an IAM OIDC provider is
# one per URL per account, so a second create would fail anyway).
#
# It trusts exactly one subject, repo:<books_github_repo>:environment:<books_github_environment>,
# with StringEquals. GitHub puts that subject on the token of any job that declares the environment;
# the environment's protection rule (main only — books-automation.md "One-time maintainer steps" 6)
# is what keeps a pull request or another branch from reaching it.
#
# What it can do: file the monthly package (PutObject under records/), read back what is in the
# archive (records/ and inbound/), use the bucket's key only through S3, and read the one connectors
# secret. What it can NEVER do: delete, overwrite a locked version, change retention or a legal hold,
# or touch the bucket's configuration — the bucket policy denies all of it even if this grant widens.

locals {
  github_oidc_host = "token.actions.githubusercontent.com"
  github_subject   = "repo:${var.books_github_repo}:environment:${var.books_github_environment}"
}

data "aws_iam_openid_connect_provider" "github" {
  url = "https://${local.github_oidc_host}"
}

data "aws_iam_policy_document" "books_trust" {
  statement {
    sid     = "BooksRepoOneEnvironment"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:sub"
      values   = [local.github_subject]
    }
  }
}

resource "aws_iam_role" "books" {
  name                 = local.books_role_name
  description          = "The books repository's monthly close and daily ledger: files records/, reads inbound/ + records/, reads alethia/books/connectors. Created by infra/books-archive."
  assume_role_policy   = data.aws_iam_policy_document.books_trust.json
  max_session_duration = 3600

  lifecycle {
    precondition {
      condition     = var.backup_account_id != var.alethia_account_id
      error_message = "backup_account_id equals alethia_account_id. The archive must be out of reach of everything that can reach production; it needs its own account."
    }
  }
}

data "aws_iam_policy_document" "books" {
  statement {
    sid       = "FileRecords"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${local.bucket_arn}/${local.records_prefix}*"]
  }

  statement {
    sid     = "ReadInboundAndRecords"
    effect  = "Allow"
    actions = ["s3:GetObject"]
    resources = [
      "${local.bucket_arn}/${local.inbound_prefix}*",
      "${local.bucket_arn}/${local.records_prefix}*",
    ]
  }

  statement {
    sid       = "ListInboundAndRecords"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = [local.inbound_prefix, "${local.inbound_prefix}*", local.records_prefix, "${local.records_prefix}*"]
    }
  }

  # S3 calls KMS on the role's behalf to encrypt (GenerateDataKey) and to read back (Decrypt) under
  # the bucket key; a multipart upload needs both. ViaService confines them to calls that came
  # through S3, the alias to this one key.
  statement {
    sid       = "UseTheBucketKeyThroughS3Only"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [local.kms_key_arn_pattern]
    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "kms:ResourceAliases"
      values   = [local.kms_alias_name]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = [local.s3_via_service]
    }
  }

  # The secret is encrypted with the AWS-managed aws/secretsmanager key (secret.tf), whose key policy
  # already admits any principal of this account calling through Secrets Manager — so this role needs
  # no KMS grant beyond the S3 one above.
  statement {
    sid       = "ReadTheConnectorsSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.connectors_secret_arn_pattern]
  }
}

resource "aws_iam_role_policy" "books" {
  name   = "alethia-books-monthly"
  role   = aws_iam_role.books.id
  policy = data.aws_iam_policy_document.books.json
}
