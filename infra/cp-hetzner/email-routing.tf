# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Inbound email for alethialabs.io via Cloudflare Email Routing (free). Receives
# at the human/receiving apex addresses (support@, sales@, …) and forwards them to
# a single inbox, so the addresses printed across the product (transactional email
# footers, marketing contact form, CLA/legal/security pages) actually reach someone.
#
# Coexists with the AWS SES send stack (infra/email-ses): SES sends from the auth.*
# and mail.* SUBDOMAINS with their own bounce.* MX, while Email Routing claims the
# APEX MX — which was empty — so there is no conflict. Reply-as (sending FROM these
# addresses) is handled out-of-band by Gmail "Send mail as" over SES SMTP; see the
# apex SES identity in infra/email-ses and scripts/gmail-inbox-setup.mjs.
#
# The apex MX + SPF records are provisioned automatically by Cloudflare when Email
# Routing is enabled (skip_wizard defaults to false); their exact MX priorities are
# randomised per-zone by Cloudflare and carry no meaning, so we intentionally do not
# pin them here. Only the rules/address (which we do want in code) are declared.

locals {
  # Apex addresses that need a real receiving mailbox. Do NOT list hello@ / no-reply@
  # here — those are SES OUTBOUND on the mail.*/auth.* subdomains, not the apex.
  inbound_addresses = [
    "support",  # user support (shown in transactional email footers)
    "sales",    # marketing contact/demo form recipient
    "legal",    # CLA + legal/privacy/terms contact
    "security", # vulnerability disclosure
    "feedback", # hosted in-app feedback widget inbox
    "dmarc",    # automated DMARC aggregate reports (rua=mailto:dmarc@)
    "borislav", # founder personal
  ]
}

# Turn on Email Routing for the zone. Enabling runs Cloudflare's wizard, which adds
# the required apex MX (route{1,2,3}.mx.cloudflare.net) + SPF
# (v=spf1 include:_spf.mx.cloudflare.net ~all) records for us.
resource "cloudflare_email_routing_settings" "zone" {
  count = var.manage_email_routing ? 1 : 0

  zone_id = var.cloudflare_zone_id
  enabled = true
}

# Destination inbox. Account-scoped and NOT verified by Terraform: Cloudflare emails
# a confirmation link to this address that must be clicked once (see README). Rules
# below won't deliver until it's verified.
resource "cloudflare_email_routing_address" "dest" {
  count = var.manage_email_routing ? 1 : 0

  account_id = var.cloudflare_account_id
  email      = var.email_forward_to
}

# One forward rule per apex address → the destination inbox.
resource "cloudflare_email_routing_rule" "inbound" {
  for_each = var.manage_email_routing ? toset(local.inbound_addresses) : toset([])

  zone_id = var.cloudflare_zone_id
  name    = "forward-${each.key}"
  enabled = true

  matcher {
    type  = "literal"
    field = "to"
    value = "${each.key}@${var.domain}"
  }

  action {
    type  = "forward"
    value = [cloudflare_email_routing_address.dest[0].email]
  }

  depends_on = [cloudflare_email_routing_settings.zone]
}

# Everything else addressed to the apex is dropped (bounced) rather than forwarded,
# so spam to random local-parts doesn't flood the inbox. Switch action.type to
# "forward" (+ value) to catch-all instead.
resource "cloudflare_email_routing_catch_all" "drop" {
  count = var.manage_email_routing ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "drop-unmatched"
  enabled = true

  matcher {
    type = "all"
  }

  action {
    type = "drop"
    # Required by the provider schema even for drop; empty since nothing is forwarded.
    value = []
  }

  depends_on = [cloudflare_email_routing_settings.zone]
}
