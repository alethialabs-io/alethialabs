# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Customer-managed KMS key encrypting both SNS topics at rest (AVD-AWS-0095), as in
# infra/email-ses/kms.tf. Both topics are published to by AWS SERVICES (SES, CloudWatch), so the key
# policy must let those services use the key, in addition to the sns:Publish grants in sns.tf. The
# HTTPS and email subscribers are unaffected: SNS decrypts before delivery.

resource "aws_kms_key" "sns" {
  description             = "Alethia SES notification topics (events + alarms) at-rest encryption, alethia-email account."
  enable_key_rotation     = true
  deletion_window_in_days = 7
  policy                  = data.aws_iam_policy_document.sns_kms.json
}

resource "aws_kms_alias" "sns" {
  name          = "alias/alethia-ses-sns"
  target_key_id = aws_kms_key.sns.key_id
}

data "aws_iam_policy_document" "sns_kms" {
  # The account keeps full control of the key, so IAM (the admin role) can manage it and a bad
  # policy cannot lock everyone out.
  statement {
    sid       = "AccountAdmin"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.email_account_id}:root"]
    }
  }

  # SES publishes events to the encrypted `events` topic and CloudWatch publishes alarm state changes
  # to the encrypted `alarms` topic. Each generates and decrypts the data key server-side, scoped to
  # this account.
  statement {
    sid       = "AllowServicePublishersUseOfKey"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com", "cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.email_account_id]
    }
  }
}
