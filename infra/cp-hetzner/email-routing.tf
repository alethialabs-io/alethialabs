# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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
    "privacy",  # data-subject requests + DPA/subprocessor notices
    "security", # vulnerability disclosure
    "feedback", # hosted in-app feedback widget inbox
    "dmarc",    # automated DMARC aggregate reports (rua=mailto:dmarc@)
    "borislav", # founder personal
  ]

  # The local-parts that were LIVE in Cloudflare before this stack owned them (#4374), and so must
  # be imported rather than created. Frozen on purpose: an address added to inbound_addresses later
  # does not exist yet and is simply created, so it must NOT be listed here.
  adopted_addresses = [
    "support", "sales", "legal", "privacy", "security", "feedback", "dmarc", "borislav",
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

  lifecycle {
    # Fail the PLAN, not the apply, when the input is flipped without what adoption needs. Without
    # the ID the address is not imported (email-routing-imports.tf) and would be created again.
    precondition {
      condition     = var.email_routing_address_id != "" && var.email_forward_to != ""
      error_message = "manage_email_routing = true needs email_routing_address_id (the live destination address's id) and email_forward_to — see #4374 and the README's adoption steps."
    }
  }
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

  lifecycle {
    # An adopted address with no rule id is not imported, and would be CREATED as a second forward
    # rule next to the live one. Fail the plan instead. Addresses added after adoption are not in
    # local.adopted_addresses and are created normally.
    precondition {
      condition     = !contains(local.adopted_addresses, each.key) || contains(keys(var.email_routing_rule_ids), each.key)
      error_message = "manage_email_routing = true but email_routing_rule_ids has no id for this adopted address; supply every live rule id (#4374) so it is imported, not created a second time."
    }
  }
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
