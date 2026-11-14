# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that infra/email-ses-account plans what it claims from the committed terraform.tfvars, and
# that its refusals and checks FIRE — a guard nobody has seen fail is indistinguishable from no guard.
#
# Plan-only and credential-free, the same harness as infra/aws-e2e/checks.tftest.hcl. The provider
# block below REPLACES the stack's (dropping the assume_role and allowed_account_ids, so nothing calls
# STS), and the two data sources that would call AWS are overridden. The provider is the REAL one, not
# a mock: aws_iam_policy_document renders locally, and a mocked one returns random JSON — every
# policy assertion below would then be about noise.
#
#   cd infra/email-ses-account && tofu init -backend=false && tofu test
# Run in CI by .github/workflows/infra-email-ses-account.yml.

provider "aws" {
  region                      = "eu-central-1"
  access_key                  = "mock"
  secret_key                  = "mock"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = "604925221417"
  }
}

# The live identity as `aws sesv2 get-email-identity` describes it: a verified DOMAIN identity.
override_data {
  target = data.aws_sesv2_email_identity.domain
  values = {
    arn                         = "arn:aws:ses:eu-central-1:604925221417:identity/alethialabs.io"
    identity_type               = "DOMAIN"
    verified_for_sending_status = true
  }
}

# Computed ARNs, as AWS would return them. A plan cannot know them, and `tofu test` fails a run whose
# check is unknown — so they are pinned to the values AWS builds from the names. The drift run at the
# end replaces one with a different value and expects the matching check to fire.
override_resource {
  target = aws_sns_topic.events
  values = {
    arn = "arn:aws:sns:eu-central-1:604925221417:alethia-ses-events"
  }
}

override_resource {
  target = aws_sns_topic.alarms
  values = {
    arn = "arn:aws:sns:eu-central-1:604925221417:alethia-ses-alarms"
  }
}

override_resource {
  target = aws_kms_key.sns
  values = {
    id     = "00000000-0000-0000-0000-000000000000"
    key_id = "00000000-0000-0000-0000-000000000000"
    arn    = "arn:aws:kms:eu-central-1:604925221417:key/00000000-0000-0000-0000-000000000000"
  }
}

variables {
  # The one input that is never committed. [] is the explicit opt-out.
  ses_alarm_emails = []
}

# ── The committed posture ────────────────────────────────────────────────────────────────────────

run "committed_posture_plans_the_email_account" {
  command = plan

  assert {
    condition     = toset([for cs in aws_sesv2_configuration_set.stream : cs.configuration_set_name]) == toset(["alethia-auth", "alethia-general"])
    error_message = "the configuration sets must keep infra/email-ses's names, which ALETHIA_SES_*_CONFIG_SET documents."
  }
  assert {
    condition = alltrue([
      for k in ["auth", "general"] :
      toset(aws_sesv2_configuration_set_event_destination.sns[k].event_destination[0].matching_event_types) == toset(["BOUNCE", "COMPLAINT", "DELIVERY", "REJECT", "RENDERING_FAILURE"])
    ])
    error_message = "each set must publish the same five event types as infra/email-ses."
  }
  assert {
    condition = alltrue([
      for k in ["auth", "general"] :
      aws_sesv2_configuration_set.stream[k].delivery_options[0].tls_policy == "REQUIRE" && toset(aws_sesv2_configuration_set.stream[k].suppression_options[0].suppressed_reasons) == toset(["BOUNCE", "COMPLAINT"])
    ])
    error_message = "each set must require TLS and suppress bounces and complaints."
  }
  assert {
    condition     = aws_sns_topic.events.name == "alethia-ses-events" && aws_sns_topic.alarms.name == "alethia-ses-alarms"
    error_message = "the topics must keep infra/email-ses's names."
  }
  assert {
    condition     = length(aws_sns_topic_subscription.events_https) == 1 && aws_sns_topic_subscription.events_https[0].endpoint == "https://alethialabs.io/api/webhooks/ses" && aws_sns_topic_subscription.events_https[0].protocol == "https"
    error_message = "the committed webhook must plan one HTTPS subscription to the production console route."
  }
  assert {
    condition     = output.app_env.ALETHIA_SES_EVENTS_TOPIC_ARNS == "arn:aws:sns:eu-central-1:604925221417:alethia-ses-events"
    error_message = "the topic ARN the console must accept is the email account's alethia-ses-events in eu-central-1 (scripts/ci/deploy-console-assemble-env.sh defaults to this literal)."
  }
  assert {
    condition     = output.app_env.EMAIL_PROVIDER == "ses" && output.app_env.ALETHIA_SES_REGION == "eu-central-1" && output.app_env.ALETHIA_SES_AUTH_CONFIG_SET == "alethia-auth" && output.app_env.ALETHIA_SES_GENERAL_CONFIG_SET == "alethia-general"
    error_message = "app_env must name the provider, region and both config sets the app reads."
  }
  assert {
    condition     = aws_iam_user.sender.name == "alethia-ses-sender" && aws_iam_user.sender.path == "/alethia-email/"
    error_message = "the sender user must be alethia-ses-sender under /alethia-email/."
  }
  assert {
    condition = toset(jsondecode(aws_iam_user_policy.sender.policy).Statement[0].Resource) == toset([
      "arn:aws:ses:eu-central-1:604925221417:identity/alethialabs.io",
      "arn:aws:ses:eu-central-1:604925221417:configuration-set/alethia-auth",
      "arn:aws:ses:eu-central-1:604925221417:configuration-set/alethia-general",
    ])
    error_message = "the sender may send only as the alethialabs.io identity and through the two config sets."
  }
  assert {
    condition     = toset(jsondecode(aws_iam_user_policy.sender.policy).Statement[0].Action) == toset(["ses:SendEmail", "ses:SendRawEmail"]) && length(jsondecode(aws_iam_user_policy.sender.policy).Statement) == 1
    error_message = "the sender's policy must be one statement granting exactly ses:SendEmail and ses:SendRawEmail."
  }
  assert {
    condition     = aws_sns_topic.events.kms_master_key_id == "00000000-0000-0000-0000-000000000000" && aws_sns_topic.alarms.kms_master_key_id == "00000000-0000-0000-0000-000000000000"
    error_message = "both topics must be encrypted with the stack's KMS key."
  }
  assert {
    condition     = !strcontains(aws_iam_user_policy.sender.policy, "aws:SourceIp")
    error_message = "the committed sender_source_cidrs is [], so the policy must carry no IP condition."
  }
  assert {
    condition     = !strcontains(aws_iam_user_policy.sender.policy, "270587882865") && !strcontains(data.aws_iam_policy_document.events_topic.json, "270587882865")
    error_message = "nothing the email account grants may name the Alethia platform account."
  }
  assert {
    condition     = strcontains(data.aws_iam_policy_document.events_topic.json, "ses.amazonaws.com") && strcontains(data.aws_iam_policy_document.events_topic.json, "604925221417")
    error_message = "only SES, for this account, may publish to the events topic."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.bounce_rate.threshold == 0.05 && aws_cloudwatch_metric_alarm.complaint_rate.threshold == 0.001
    error_message = "the reputation alarms must keep infra/email-ses's thresholds."
  }
  assert {
    condition     = aws_sesv2_account_vdm_attributes.this.vdm_enabled == "ENABLED" && toset(aws_sesv2_account_suppression_attributes.this.suppressed_reasons) == toset(["BOUNCE", "COMPLAINT"])
    error_message = "VDM must be on and the account suppression list must cover bounces and complaints."
  }
}

run "webhook_null_plans_no_https_subscription" {
  command = plan
  variables {
    events_webhook_url = null
  }

  assert {
    condition     = length(aws_sns_topic_subscription.events_https) == 0
    error_message = "with the webhook unset, no HTTPS subscription may be planned."
  }
}

run "source_cidrs_add_an_ip_condition" {
  command = plan
  variables {
    sender_source_cidrs = ["203.0.113.10/32"]
  }

  assert {
    condition     = strcontains(aws_iam_user_policy.sender.policy, "aws:SourceIp") && strcontains(aws_iam_user_policy.sender.policy, "203.0.113.10/32")
    error_message = "a non-empty sender_source_cidrs must lock the send permission to those addresses."
  }
}

run "alarm_emails_each_get_a_subscription" {
  command = plan
  variables {
    ses_alarm_emails = ["ops@example.com", "oncall@example.com"]
  }

  assert {
    condition     = length(aws_sns_topic_subscription.alarms_email) == 2
    error_message = "every alarm address must get its own email subscription."
  }
}

# ── Refusals ─────────────────────────────────────────────────────────────────────────────────────

run "the_platform_account_as_the_email_account_is_refused" {
  command = plan
  variables {
    email_account_id = "270587882865"
  }

  # The precondition is the refusal. The two checks fire as well, because the caller identity (still
  # the email account) and the built topic ARN (now in the platform account) both disagree with it.
  expect_failures = [
    aws_iam_user.sender,
    check.email_account_is_the_dedicated_one,
    check.events_topic_is_the_one_the_console_accepts,
  ]
}

run "an_unverified_identity_is_refused" {
  command = plan

  override_data {
    target = data.aws_sesv2_email_identity.domain
    values = {
      arn                         = "arn:aws:ses:eu-central-1:604925221417:identity/alethialabs.io"
      identity_type               = "DOMAIN"
      verified_for_sending_status = false
    }
  }

  expect_failures = [data.aws_sesv2_email_identity.domain]
}

run "a_plain_http_webhook_is_refused" {
  command = plan
  variables {
    events_webhook_url = "http://alethialabs.io/api/webhooks/ses"
  }

  expect_failures = [var.events_webhook_url]
}

run "a_whole_internet_source_cidr_is_refused" {
  command = plan
  variables {
    sender_source_cidrs = ["0.0.0.0/0"]
  }

  expect_failures = [var.sender_source_cidrs]
}

# ── Each check can fire ──────────────────────────────────────────────────────────────────────────

run "the_wrong_account_fires_the_account_check" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }

  expect_failures = [check.email_account_is_the_dedicated_one]
}

run "a_topic_arn_the_console_does_not_expect_fires_the_contract_check" {
  command = plan

  override_resource {
    target = aws_sns_topic.events
    values = {
      arn = "arn:aws:sns:us-east-1:604925221417:alethia-ses-events"
    }
  }

  expect_failures = [check.events_topic_is_the_one_the_console_accepts]
}
