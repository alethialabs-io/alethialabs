# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# SNS topics. `events` carries SES bounce/complaint/delivery notifications from
# the per-stream configuration sets (config-sets.tf) to the console webhook.
# `alarms` carries CloudWatch reputation alarms (cloudwatch.tf) to an ops inbox.

resource "aws_sns_topic" "events" {
  name              = "alethia-ses-events"
  kms_master_key_id = aws_kms_key.sns.id # encrypt at rest (see kms.tf)
  tags              = local.tags
}

resource "aws_sns_topic" "alarms" {
  name              = "alethia-ses-alarms"
  kms_master_key_id = aws_kms_key.sns.id # encrypt at rest (see kms.tf)
  tags              = local.tags
}

# Let SES publish event notifications to the events topic (scoped to this account).
data "aws_iam_policy_document" "events_topic" {
  statement {
    sid     = "AllowSESPublish"
    effect  = "Allow"
    actions = ["sns:Publish"]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    resources = [aws_sns_topic.events.arn]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "events" {
  arn    = aws_sns_topic.events.arn
  policy = data.aws_iam_policy_document.events_topic.json
}

# Let CloudWatch publish alarm state changes to the alarms topic.
data "aws_iam_policy_document" "alarms_topic" {
  statement {
    sid     = "AllowCloudWatchPublish"
    effect  = "Allow"
    actions = ["sns:Publish"]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    resources = [aws_sns_topic.alarms.arn]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alarms" {
  arn    = aws_sns_topic.alarms.arn
  policy = data.aws_iam_policy_document.alarms_topic.json
}

# HTTPS subscription to the console handler. Created only once events_webhook_url
# is set — the app endpoint must be live to auto-confirm the subscription, so
# apply this after deploying the /api/webhooks/ses route (see README ordering).
resource "aws_sns_topic_subscription" "events_https" {
  count = var.events_webhook_url == "" ? 0 : 1

  topic_arn              = aws_sns_topic.events.arn
  protocol               = "https"
  endpoint               = var.events_webhook_url
  endpoint_auto_confirms = true
  raw_message_delivery   = false
}

# Email subscription so the ops inbox gets reputation alarms (confirm via email).
resource "aws_sns_topic_subscription" "alarms_email" {
  count = var.alarm_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}
