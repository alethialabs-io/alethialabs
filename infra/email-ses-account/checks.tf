# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Loud invariant assertions. A `check` block WARNS: `tofu plan` still exits 0 with the message
# printed. The properties that must be UN-APPLIABLE rather than noisy are enforced elsewhere and say
# so: the account pin is the provider's allowed_account_ids, the not-the-platform-account rule is a
# precondition on the sender user, the identity's readiness is a postcondition on its data source.
#
# checks.tftest.hcl makes the two checks that read LIVE values fire (the caller's account, and the
# topic ARN AWS returns). The other three read only this stack's own code, with no input that can
# move them, so they guard an EDIT; the test's posture run asserts the same properties directly.

# ── The account ──────────────────────────────────────────────────────────────────────────────────
check "email_account_is_the_dedicated_one" {
  assert {
    condition = alltrue([
      data.aws_caller_identity.current.account_id == var.email_account_id,
      data.aws_caller_identity.current.account_id != var.alethia_account_id,
    ])
    error_message = "the provider is operating in ${data.aws_caller_identity.current.account_id}, not the dedicated email account ${var.email_account_id} (or that is the Alethia platform account)."
  }
}

# ── The webhook contract ─────────────────────────────────────────────────────────────────────────
check "events_topic_is_the_one_the_console_accepts" {
  assert {
    # The console accepts only exact ARNs (ALETHIA_SES_EVENTS_TOPIC_ARNS), and the production deploy
    # defaults that list to the BUILT ARN in main.tf. A topic renamed here, or created in another
    # region or account, would publish to a webhook that refuses every message. On the first plan the
    # right side is unknown, so this reports at apply; on every plan after it, at plan.
    condition     = aws_sns_topic.events.arn == local.events_topic_arn
    error_message = "the events topic is ${aws_sns_topic.events.arn}, but the console and the deploy default expect ${local.events_topic_arn}. Change both together."
  }
}

check "every_stream_publishes_bounces_and_complaints_to_the_events_topic" {
  assert {
    condition = alltrue([
      for k in local.streams : alltrue([
        contains(aws_sesv2_configuration_set_event_destination.sns[k].event_destination[0].matching_event_types, "BOUNCE"),
        contains(aws_sesv2_configuration_set_event_destination.sns[k].event_destination[0].matching_event_types, "COMPLAINT"),
        aws_sesv2_configuration_set_event_destination.sns[k].event_destination[0].enabled,
      ])
    ])
    error_message = "every configuration set must publish BOUNCE and COMPLAINT to SNS, enabled: those two are what drive the console's suppression list."
  }
}

# ── The sender ───────────────────────────────────────────────────────────────────────────────────
check "sender_can_only_send" {
  assert {
    condition = alltrue([
      length(jsondecode(data.aws_iam_policy_document.sender.json).Statement) == 1,
      toset(flatten([jsondecode(data.aws_iam_policy_document.sender.json).Statement[0].Action])) == toset(["ses:SendEmail", "ses:SendRawEmail"]),
      jsondecode(data.aws_iam_policy_document.sender.json).Statement[0].Effect == "Allow",
      !strcontains(data.aws_iam_policy_document.sender.json, "\"*\""),
    ])
    error_message = "the sender's policy must be ONE Allow of exactly ses:SendEmail + ses:SendRawEmail, with no wildcard resource."
  }
}


# ── Encryption ───────────────────────────────────────────────────────────────────────────────────
check "topics_are_encrypted_with_the_stack_key" {
  assert {
    condition = alltrue([
      aws_sns_topic.events.kms_master_key_id == aws_kms_key.sns.id,
      aws_sns_topic.alarms.kms_master_key_id == aws_kms_key.sns.id,
    ])
    error_message = "both SNS topics must be encrypted with this stack's KMS key (its policy is what lets SES and CloudWatch publish to them)."
  }
}
