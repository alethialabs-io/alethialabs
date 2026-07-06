# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Account reputation alarms. AWS auto-pauses sending at a 10% bounce / 0.5%
# complaint rate, so these fire well below that to give us warning. They publish
# to the alarms SNS topic (sns.tf).

resource "aws_cloudwatch_metric_alarm" "bounce_rate" {
  alarm_name          = "alethia-ses-bounce-rate"
  alarm_description   = "SES account bounce rate is elevated (AWS pauses sending at 0.10)."
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
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "complaint_rate" {
  alarm_name          = "alethia-ses-complaint-rate"
  alarm_description   = "SES account complaint rate is elevated (AWS pauses sending at 0.005)."
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
  tags                = local.tags
}
