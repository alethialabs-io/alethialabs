# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Customer-managed KMS key encrypting the SNS notification topics (events + alarms) at
# rest (AVD-AWS-0095). The topics carry SES bounce/complaint events and CloudWatch
# reputation alarms; both are published by AWS SERVICES, so the key policy must let those
# services use the key (server-side) in addition to sns:Publish (granted in sns.tf).
# The https/email subscribers are unaffected — SNS decrypts before delivery.

resource "aws_kms_key" "sns" {
  description             = "Alethia SES notification SNS topics (events + alarms) at-rest encryption."
  enable_key_rotation     = true
  deletion_window_in_days = 7
  policy                  = data.aws_iam_policy_document.sns_kms.json
  tags                    = local.tags
}

resource "aws_kms_alias" "sns" {
  name          = "alias/alethia-ses-sns"
  target_key_id = aws_kms_key.sns.key_id
}

data "aws_iam_policy_document" "sns_kms" {
  # Account admin keeps full control of the key (prevents lockout / lets the deploy role
  # and humans manage it).
  statement {
    sid       = "AccountAdmin"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }

  # SES publishes bounce/complaint/delivery events to the encrypted `events` topic, and
  # CloudWatch publishes alarm state changes to the encrypted `alarms` topic. Each needs
  # to generate/decrypt the data key server-side — scoped to this account.
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
      values   = [local.account_id]
    }
  }
}
