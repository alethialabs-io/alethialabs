# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Dedicated IAM user whose access key converts to SES SMTP credentials for Gmail
# "Send mail as" — so a human can reply *as* support@/sales@/legal@/security@/
# borislav@alethialabs.io (see scripts/gmail-inbox-setup.mjs). Scoped to
# SendRawEmail from the apex identity only (least-privilege; separate from the
# runtime app sender so the two never share a key).
#
# Terraform can't derive the SMTP *password* from the secret access key (it's an
# HMAC of the key). So this stack owns only the least-priv user; minting the key
# and converting it is a one-time runbook step — see infra/email-ses/README.md §6.

resource "aws_iam_user" "smtp_gmail" {
  name = "alethia-ses-smtp-gmail"
  tags = local.tags
}

data "aws_iam_policy_document" "smtp_gmail_send" {
  statement {
    sid       = "SendAsFromApexIdentity"
    effect    = "Allow"
    actions   = ["ses:SendRawEmail"]
    resources = [local.apex_identity_arn]
  }
}

resource "aws_iam_user_policy" "smtp_gmail_send" {
  name   = "alethia-ses-smtp-gmail-send"
  user   = aws_iam_user.smtp_gmail.name
  policy = data.aws_iam_policy_document.smtp_gmail_send.json
}
