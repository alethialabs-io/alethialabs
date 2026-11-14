# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Hosted transactional email: AWS SES in the dedicated `alethia-email` account (eu-central-1), which
# holds SES production access. infra/email-ses describes the same pieces in the Alethia platform
# account, where AWS denied production access; this stack is what the app sends through instead.
#
# What it creates, mirroring infra/email-ses where the two overlap:
#   config-sets.tf  alethia-auth / alethia-general, each publishing events to SNS
#   sns.tf          alethia-ses-events → the console /api/webhooks/ses; alethia-ses-alarms → inboxes
#   kms.tf          the key both topics are encrypted with
#   cloudwatch.tf   account bounce-rate and complaint-rate alarms
#   account.tf      account VDM and the account-level suppression list
#   sender.tf       alethia-ses-sender, the IAM user the app sends as (no access key in this stack)
#
# What it deliberately does NOT do:
#   · create or import the domain identity. It was created and verified (Easy DKIM) by hand before
#     this stack existed; identity.tf reads it and fails the plan if it is missing or unverified.
#   · manage DNS. The DKIM CNAMEs live at Cloudflare, as for infra/email-ses.
#   · request production access. That is an AWS support decision, already granted.

locals {
  # The app's two sending streams (packages/email/src/config.ts: EmailConfigSets). The set names are
  # `alethia-<stream>`, the same as infra/email-ses, so ALETHIA_SES_AUTH_CONFIG_SET /
  # ALETHIA_SES_GENERAL_CONFIG_SET keep the values its README documents.
  streams = toset(["auth", "general"])

  # The same five event types as infra/email-ses/config-sets.tf. The webhook acts on Bounce and
  # Complaint and answers 200 to the other three without acting on them.
  event_types = ["BOUNCE", "COMPLAINT", "DELIVERY", "REJECT", "RENDERING_FAILURE"]

  # The webhook (apps/console/app/api/webhooks/ses/route.ts) accepts only the EXACT topic ARNs in
  # ALETHIA_SES_EVENTS_TOPIC_ARNS, and the production deploy defaults that variable to this ARN
  # (scripts/ci/deploy-console-assemble-env.sh). Built rather than read so a check can compare the
  # two and so the value is known at plan time.
  events_topic_name = "alethia-ses-events"
  events_topic_arn  = "arn:aws:sns:${var.email_region}:${var.email_account_id}:${local.events_topic_name}"
  alarms_topic_name = "alethia-ses-alarms"

  # ONE source for each set's name, used both to create the set (config-sets.tf) and to build the
  # ARN the sender's policy names (sender.tf). Built so the policy renders at plan time; the ARN is
  # AWS's documented arn:aws:ses:<region>:<account>:configuration-set/<name> form, and because the
  # name comes from the same map in both places, the two cannot drift apart.
  config_set_names = { for k in local.streams : k => "alethia-${k}" }
  config_set_arns = {
    for k, name in local.config_set_names : k => "arn:aws:ses:${var.email_region}:${var.email_account_id}:configuration-set/${name}"
  }
}
