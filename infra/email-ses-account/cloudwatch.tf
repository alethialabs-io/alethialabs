# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Account reputation alarms, identical to infra/email-ses/cloudwatch.tf. AWS puts an account under
# review at a 5% bounce / 0.1% complaint rate and may pause sending at 10% / 0.5%, so these fire at
# or below the review line. They publish to the alarms topic (sns.tf). Sign-in codes go out through
# this account, so a paused account is a sign-in outage.

resource "aws_cloudwatch_metric_alarm" "bounce_rate" {
  alarm_name          = "alethia-ses-bounce-rate"
  alarm_description   = "SES account bounce rate is elevated (AWS reviews at 0.05 and may pause sending at 0.10). Sign-in email goes out through this account."
  namespace           = "AWS/SES"
  metric_name         = "Reputation.BounceRate"
  statistic           = "Average"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.bounce_rate_threshold
  period              = 3600
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "complaint_rate" {
  alarm_name          = "alethia-ses-complaint-rate"
  alarm_description   = "SES account complaint rate is elevated (AWS reviews at 0.001 and may pause sending at 0.005). Sign-in email goes out through this account."
  namespace           = "AWS/SES"
  metric_name         = "Reputation.ComplaintRate"
  statistic           = "Average"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.complaint_rate_threshold
  period              = 3600
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# The events topic failing to deliver to the console's webhook. SNS retries an HTTPS endpoint and
# then DROPS the message, and a dropped bounce or complaint never reaches `email_suppression`: the
# app keeps mailing an address that bounced, which is exactly what drives the bounce rate above
# towards the review line. A 403 from Cloudflare, a 5xx from the box or a broken route all look like
# this, and none of them is visible anywhere else. Any failure in an hour fires.
#
# Rejects and rendering failures per configuration set are NOT alarmed here: the sets publish their
# events to SNS only (config-sets.tf). A per-set CloudWatch metric needs a CloudWatch event
# destination on each set, which is a separate decision.
resource "aws_cloudwatch_metric_alarm" "events_delivery_failed" {
  alarm_name          = "alethia-ses-events-delivery-failed"
  alarm_description   = "SNS could not deliver SES events (bounces, complaints) from alethia-ses-events to the console webhook. Undelivered bounces never reach the suppression list. Check https://alethialabs.io/api/webhooks/ses and the subscription."
  namespace           = "AWS/SNS"
  metric_name         = "NumberOfNotificationsFailed"
  dimensions          = { TopicName = local.events_topic_name }
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 3600
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}
