# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Runtime send permission. The sender user already exists (its access key is the
# one in the app's env) and is intentionally NOT managed here — we only attach a
# least-privilege inline send policy scoped to our identities + config sets, so
# the live key is never touched.
#
# An optional verifier user (send + read the events topic) backs the
# verification/spike job.

data "aws_iam_user" "sender" {
  user_name = var.sender_user_name
}

locals {
  identity_arns = [
    for k, s in var.streams :
    "arn:aws:ses:${local.region}:${local.account_id}:identity/${local.fqdn[k]}"
  ]
  config_set_arns = [
    for k, s in var.streams :
    "arn:aws:ses:${local.region}:${local.account_id}:configuration-set/alethia-${k}"
  ]
}

# ses:SendEmail / SendRawEmail need both the identity and the configuration-set
# resource (the app sends with ConfigurationSetName).
data "aws_iam_policy_document" "send" {
  statement {
    sid       = "SendScopedToAlethiaStreams"
    effect    = "Allow"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = concat(local.identity_arns, local.config_set_arns)
  }
}

resource "aws_iam_user_policy" "sender_send" {
  name   = "alethia-ses-send"
  user   = data.aws_iam_user.sender.user_name
  policy = data.aws_iam_policy_document.send.json
}

# ---- Verification / spike user (optional) ----------------------------------

resource "aws_iam_user" "verifier" {
  count = var.create_verifier_user ? 1 : 0
  name  = "alethia-ses-spike"
  tags  = local.tags
}

resource "aws_iam_access_key" "verifier" {
  count = var.create_verifier_user ? 1 : 0
  user  = aws_iam_user.verifier[0].name
}

# Send (to the SES simulator) plus capture the resulting bounce/complaint off the
# events topic through a temporary SQS queue (verify.sh). Scoped so this spike
# user can run the verifier without admin rights.
data "aws_iam_policy_document" "verifier" {
  statement {
    sid       = "SendForVerification"
    effect    = "Allow"
    actions   = ["ses:SendEmail", "ses:SendRawEmail", "ses:GetEmailIdentity"]
    resources = ["*"]
  }
  statement {
    sid    = "SubscribeEventsTopic"
    effect = "Allow"
    actions = [
      "sns:Subscribe",
      "sns:Unsubscribe",
      "sns:GetTopicAttributes",
      "sns:ListSubscriptionsByTopic",
    ]
    resources = [aws_sns_topic.events.arn]
  }
  # Throwaway capture queues (verify.sh names them alethia-ses-verify-*).
  statement {
    sid    = "VerifyCaptureQueue"
    effect = "Allow"
    actions = [
      "sqs:CreateQueue",
      "sqs:DeleteQueue",
      "sqs:GetQueueAttributes",
      "sqs:SetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
    ]
    resources = ["arn:aws:sqs:${local.region}:${local.account_id}:alethia-ses-verify-*"]
  }
}

resource "aws_iam_user_policy" "verifier" {
  count  = var.create_verifier_user ? 1 : 0
  name   = "alethia-ses-spike"
  user   = aws_iam_user.verifier[0].name
  policy = data.aws_iam_policy_document.verifier.json
}
