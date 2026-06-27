# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "identity_arns" {
  description = "SES domain identity ARNs per stream."
  value       = { for k, id in aws_sesv2_email_identity.stream : k => id.arn }
}

output "dkim_tokens" {
  description = "Easy-DKIM CNAME tokens per stream (already published to Cloudflare)."
  value       = { for k, id in aws_sesv2_email_identity.stream : k => id.dkim_signing_attributes[0].tokens }
}

output "configuration_set_names" {
  description = "Per-stream config-set names → ALETHIA_SES_AUTH_CONFIG_SET / ALETHIA_SES_GENERAL_CONFIG_SET."
  value       = { for k, cs in aws_sesv2_configuration_set.stream : k => cs.configuration_set_name }
}

output "events_topic_arn" {
  description = "SNS topic carrying SES bounce/complaint events to the console webhook."
  value       = aws_sns_topic.events.arn
}

output "alarms_topic_arn" {
  description = "SNS topic carrying reputation CloudWatch alarms."
  value       = aws_sns_topic.alarms.arn
}
