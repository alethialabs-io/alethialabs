# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Company mail for the alethialabs.io APEX — Google Workspace (#7261, MAIL-S3).
#
# Moved from Cloudflare Email Routing to Google Workspace on 2026-11-22, by hand in the two
# dashboards. This file is the IaC catching up: the four apex records Workspace needs are declared
# here and ADOPTED (mail-imports.tf), not created. The apex addresses the product prints
# (support@, sales@, legal@, privacy@, security@, feedback@, dmarc@) are aliases of one Workspace
# user; Google rejects unknown local-parts (no catch-all). None of that alias set lives in DNS, so
# none of it is declared here — it is Workspace admin configuration.
#
# WHAT THIS DOES NOT TOUCH. AWS SES (infra/email-ses, infra/email-ses-account) sends from its own
# Easy DKIM selectors with the default amazonses.com MAIL FROM, and reads nothing from the apex MX or
# SPF. Its records are owned by those stacks. _dmarc is not declared here either (unchanged by the
# move, and not part of #7261's scope).
#
# WHAT REPLACED email-routing.tf. The Cloudflare Email Routing declarations are retired — see the
# `removed` blocks at the bottom. Cloudflare Email Routing itself must be DISABLED for the zone (an
# operator step, README): while it is enabled, Cloudflare re-adds its own locked
# route{1,2,3}.mx.cloudflare.net apex MX records whenever the routing re-syncs, which would put two
# competing MX sets on the apex. Nothing in this stack can delete those records: they are created by
# Cloudflare, are read-only through the DNS API, and are not in this stack's state.

# MX 1 smtp.google.com — Google's single-host MX for Workspace (the 5-host aspmx set is legacy).
resource "cloudflare_record" "mail_mx_google" {
  zone_id  = var.cloudflare_zone_id
  name     = "@"
  type     = "MX"
  content  = "smtp.google.com"
  priority = 1
  ttl      = 1
}

# SPF — Google only. SES does not need an include here: its MAIL FROM is amazonses.com, so SPF is
# evaluated against Amazon's domain, not the apex. Adding _spf.mx.cloudflare.net back would
# re-authorise the retired forwarder.
#
# Cloudflare stores TXT content quoted, and these values are written exactly as the API returns
# them so that the import plans no change.
resource "cloudflare_record" "mail_spf" {
  zone_id = var.cloudflare_zone_id
  name    = "@"
  type    = "TXT"
  content = "\"v=spf1 include:_spf.google.com ~all\""
  ttl     = 1
}

# Google DKIM, selector `google`, 2048-bit. A public key: it is in public DNS by design. Over 255
# bytes, so Cloudflare holds it as two quoted character-strings, reproduced verbatim. Rotating the
# key in the Workspace admin console means pasting the new value here in the same change.
resource "cloudflare_record" "mail_dkim_google" {
  zone_id = var.cloudflare_zone_id
  name    = "google._domainkey"
  type    = "TXT"
  content = "\"v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAo0hGNwxJDuh8K/WthZUvUB7KE6M0ZqZnL8V1g2RoWox8Cieg2YqljS2yYDOKZacTYfvt0m2gdyx0U6HeJ/5pHX9Tqk/elPQkID4UrAiq9yzybDVFf8tEoqv7ubYp6L94JNuYVDyom/i/+t+If95sr9AZZPrwL6opE9UGgsaK+kKPk2s4M/bnt6/ZAlWW8muqS\" \"Xo5kSmL1/y9z27zrPA2kd40f4MxriEaxtCsXLJEWrp++PhCbMP3XuIp8w6X7Q0fafwh7vk7lCkEYoGb+oh5klnKD8spKKKIa4bNyVgMuqCH67KZr54onZBAfKN4rPkzK/1KPyZsvILIuBtF4yecJQIDAQAB\""
  ttl     = 1
}

# Workspace domain verification. Google re-checks it periodically; deleting it can suspend the
# Workspace domain, which is why it is in code rather than left as an untracked dashboard record.
resource "cloudflare_record" "mail_google_site_verification" {
  zone_id = var.cloudflare_zone_id
  name    = "@"
  type    = "TXT"
  content = "\"google-site-verification=C1hm16eOOsqixasFknN0C3KmgnMV8p0OvfHwHKAYKvg\""
  ttl     = 3600
}

# ── Retired: Cloudflare Email Routing (email-routing.tf, #3291/#4374) ──────────────────────────────
#
# Those declarations were gated behind manage_email_routing, which the apply workflow could only
# switch on from a MANAGE_EMAIL_ROUTING key in alethia/prod/env — absent when checked on 2026-11-22 —
# so none of the 11 objects is expected to be in state and each block below is expected to be a
# no-op. They exist for the case that cannot
# be ruled out from the repository: a LOCAL apply that adopted them. Without these blocks that state
# would plan a destroy — and the settings resource's destroy disables Email Routing through the API
# at an unreviewed moment, from an unattended `-auto-approve`. `destroy = false` makes OpenTofu
# FORGET such an object instead: it leaves state, and Cloudflare is not called. Retiring Email
# Routing in Cloudflare is then a deliberate operator step (README), not a side effect of an apply.
#
# Keep these until the stack has been applied once after this change; after that they are inert and
# may be deleted.

removed {
  from = cloudflare_email_routing_settings.zone
  lifecycle {
    destroy = false
  }
}

removed {
  from = cloudflare_email_routing_address.dest
  lifecycle {
    destroy = false
  }
}

removed {
  from = cloudflare_email_routing_rule.inbound
  lifecycle {
    destroy = false
  }
}

removed {
  from = cloudflare_email_routing_catch_all.drop
  lifecycle {
    destroy = false
  }
}
