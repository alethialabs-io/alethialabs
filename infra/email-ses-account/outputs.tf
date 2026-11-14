# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# None of these is a secret. `app_env` is the non-secret half of the switch to SES (README step 7);
# the access key pair is the secret half and is never an output.

output "email_account_id" {
  description = "The account the provider actually operated in, read back from STS (not echoed from the variable)."
  value       = data.aws_caller_identity.current.account_id
}

output "identity_arn" {
  description = "The domain identity the sender may send as."
  value       = data.aws_sesv2_email_identity.domain.arn
}

output "configuration_set_names" {
  description = "Per-stream configuration sets → ALETHIA_SES_AUTH_CONFIG_SET / ALETHIA_SES_GENERAL_CONFIG_SET."
  value       = { for k, cs in aws_sesv2_configuration_set.stream : k => cs.configuration_set_name }
}

output "events_topic_arn" {
  description = "The SNS topic carrying SES events to the console webhook. The console accepts it only if it is listed in ALETHIA_SES_EVENTS_TOPIC_ARNS."
  value       = aws_sns_topic.events.arn
}

output "alarms_topic_arn" {
  description = "The SNS topic carrying the reputation alarms."
  value       = aws_sns_topic.alarms.arn
}

output "sender_user_name" {
  description = "The IAM user to mint the app's access key for (README step 5): aws iam create-access-key --user-name <this>."
  value       = aws_iam_user.sender.name
}

output "app_env" {
  description = "The non-secret vault values that switch hosted prod to SES (README step 7). ALETHIA_SES_ACCESS_KEY_ID / ALETHIA_SES_SECRET_ACCESS_KEY come from step 5, never from here."
  value = {
    EMAIL_PROVIDER                 = "ses"
    ALETHIA_SES_REGION             = var.email_region
    ALETHIA_SES_AUTH_CONFIG_SET    = aws_sesv2_configuration_set.stream["auth"].configuration_set_name
    ALETHIA_SES_GENERAL_CONFIG_SET = aws_sesv2_configuration_set.stream["general"].configuration_set_name
    ALETHIA_SES_EVENTS_TOPIC_ARNS  = aws_sns_topic.events.arn
  }
}
