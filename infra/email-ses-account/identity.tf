# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The sending identity: the `alethialabs.io` DOMAIN identity, read, not managed.
#
# It already exists in the email account, verified with Easy DKIM, and its DKIM CNAMEs are already
# published at Cloudflare. Managing it here would mean importing a live, verified identity. A wrong
# attribute on that resource (a DKIM key length, a signing mode) replaces or re-keys it, and every
# send fails DMARC until the new CNAMEs propagate. Reading it gives the stack what it needs, the ARN
# for the sender's policy, and turns "the identity is not ready" into a plan-time failure.
#
# A verified domain covers its subdomains too, so a From address on auth.<domain> or mail.<domain>
# is authorised against this same identity ARN. The production deploy's default From addresses are
# on the apex (no-reply@ and hello@), which is what this identity signs as.

data "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain

  lifecycle {
    postcondition {
      condition     = self.identity_type == "DOMAIN" && self.verified_for_sending_status
      error_message = "the SES identity ${var.domain} must be a DOMAIN identity that is verified for sending in ${var.email_region}. Check it with: aws sesv2 get-email-identity --email-identity ${var.domain} --region ${var.email_region}"
    }
  }
}
