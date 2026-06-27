# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Platform transactional-email stack: AWS SES (eu-central-1, account 270587882865)
# for alethialabs.io. Two reputation-isolated sending subdomains (auth.*, mail.*)
# with DKIM + custom MAIL FROM, per-stream configuration sets that route
# bounce/complaint events to SNS (→ the console /api/webhooks/ses handler →
# suppression list), account VDM, reputation alarms, and a least-privilege send
# policy on the existing runtime user. Cloudflare owns the DNS so it never drifts.
#
# Send-only — there is no inbound (receipt rules / S3 spool) here.

locals {
  tags = {
    project = "alethia"
    role    = "email-ses"
    managed = "opentofu"
  }

  region     = var.aws_region
  account_id = data.aws_caller_identity.current.account_id

  # Fully-qualified sending subdomain per stream, e.g. auth.alethialabs.io.
  fqdn = { for k, s in var.streams : k => "${s.subdomain}.${var.domain}" }
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}
