# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# One SES domain identity per stream, with Easy DKIM (RSA-2048) and a custom
# MAIL FROM subdomain (bounce.<subdomain>) so SPF/bounces align under our domain
# and DMARC passes. The DKIM tokens + MAIL FROM endpoint must be published as DNS
# records (managed externally — see README; not by this stack).

resource "aws_sesv2_email_identity" "stream" {
  for_each = var.streams

  email_identity = local.fqdn[each.key]

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }

  tags = local.tags
}

resource "aws_sesv2_email_identity_mail_from_attributes" "stream" {
  for_each = var.streams

  email_identity   = aws_sesv2_email_identity.stream[each.key].email_identity
  mail_from_domain = "bounce.${local.fqdn[each.key]}"

  # If the MAIL FROM MX can't be resolved, fall back to the amazonses.com
  # default rather than rejecting the send.
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

# Apex (alethialabs.io) domain identity — NOT a transactional sending stream. This
# exists so a human can reply *as* the receiving addresses (support@, sales@, …) via
# Gmail "Send mail as" over SES SMTP: verifying the apex with Easy DKIM lets SES sign
# any From:@alethialabs.io with d=alethialabs.io, so DMARC passes on DKIM alignment.
# Inbound to these addresses is handled by Cloudflare Email Routing (infra/cp-hetzner);
# publish the 3 DKIM CNAMEs (dkim_tokens_apex output) once, like the other streams.
# No custom MAIL FROM / config set needed — DKIM alignment alone satisfies DMARC.
resource "aws_sesv2_email_identity" "apex" {
  email_identity = var.domain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }

  tags = local.tags
}
