# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Two topics, the same names and policies as infra/email-ses/sns.tf. `events` carries SES
# configuration-set events to the console webhook. `alarms` carries the reputation alarms
# (cloudwatch.tf) to the ops inboxes.

resource "aws_sns_topic" "events" {
  name              = local.events_topic_name
  kms_master_key_id = aws_kms_key.sns.id
}

resource "aws_sns_topic" "alarms" {
  name              = local.alarms_topic_name
  kms_master_key_id = aws_kms_key.sns.id
}

# Only SES, publishing on behalf of THIS account, may publish to the events topic.
data "aws_iam_policy_document" "events_topic" {
  statement {
    sid     = "AllowSESPublish"
    effect  = "Allow"
    actions = ["sns:Publish"]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    # The BUILT ARN (main.tf), so the policy renders at plan time; check
    # events_topic_is_the_one_the_console_accepts proves it equals the real one.
    resources = [local.events_topic_arn]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.email_account_id]
    }
  }
}

resource "aws_sns_topic_policy" "events" {
  arn    = aws_sns_topic.events.arn
  policy = data.aws_iam_policy_document.events_topic.json
}

# Only CloudWatch, for alarms in THIS account, may publish to the alarms topic.
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
      values   = [var.email_account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alarms" {
  arn    = aws_sns_topic.alarms.arn
  policy = data.aws_iam_policy_document.alarms_topic.json
}

# The console webhook. SNS sends a SubscriptionConfirmation that the route confirms by visiting the
# signed SubscribeURL, and `endpoint_auto_confirms` makes the apply WAIT for that. So the console
# must already be serving a build whose ALETHIA_SES_EVENTS_TOPIC_ARNS contains this topic's ARN,
# or the route answers 403/503, the subscription stays PendingConfirmation, and the apply fails
# after `confirmation_timeout_in_minutes`. README step 3.
resource "aws_sns_topic_subscription" "events_https" {
  count = var.events_webhook_url == null ? 0 : 1

  topic_arn                       = aws_sns_topic.events.arn
  protocol                        = "https"
  endpoint                        = var.events_webhook_url
  endpoint_auto_confirms          = true
  confirmation_timeout_in_minutes = 5
  raw_message_delivery            = false
}

# One subscription per ops inbox. Each address must click the confirmation email AWS sends.
resource "aws_sns_topic_subscription" "alarms_email" {
  for_each = toset(var.ses_alarm_emails)

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.value
}
