# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# One SES domain identity per stream, with Easy DKIM (RSA-2048) and a custom
# MAIL FROM subdomain (bounce.<subdomain>) so SPF/bounces align under our domain
# and DMARC passes. DKIM tokens + the MAIL FROM endpoint are published to DNS in
# dns.tf.

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
