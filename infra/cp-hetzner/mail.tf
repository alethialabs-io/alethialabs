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
# EMAIL ROUTING IS DISABLED, and this stack keeps it that way by not declaring it. Cloudflare Email
# Routing for the zone was disabled out of band on 2026-11-22 (21:59Z). While it was enabled,
# Cloudflare kept its own locked route{1,2,3}.mx.cloudflare.net records on the apex and refused to add
# any other MX, and a routing re-sync put those records back after they had been removed by hand.
# Nothing in this stack declares cloudflare_email_routing_settings (whose create is the API call that
# ENABLES routing), a routing rule, a catch-all or a destination address. WHAT ENFORCES THAT is only
# this absence and review: `tofu validate` accepts a cloudflare_email_routing_settings declared next
# to the `removed` blocks below (checked with 1.12.3). Do not add one for this zone — inbound to the
# console uses a subdomain (MAIL-S1 #7246, README), and its design must first prove it leaves the
# apex MX alone.

# THE APEX NAME IS THE ZONE NAME, NOT "@". These records are imported, and the provider's importer
# (cloudflare v4.52, resourceCloudflareRecordImport) stores `name` as the API's FQDN with
# ".<zone>" trimmed — which leaves an apex record as "alethialabs.io", not "@". `name` is ForceNew
# with no diff suppression, so "@" here planned all three apex records as destroy-and-recreate
# (a real plan against prod state, 2026-11-23): a window with no apex MX. var.domain is the zone
# name (the tunnel ingress in main.tf uses it as the apex hostname too). The apex CNAME in main.tf
# keeps "@" because the provider CREATED it, so "@" is what its state holds.

# MX 1 smtp.google.com — Google's single-host MX for Workspace (the 5-host aspmx set is legacy).
resource "cloudflare_record" "mail_mx_google" {
  zone_id  = var.cloudflare_zone_id
  name     = var.domain
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
# them (GET /zones/{zone_id}/dns_records, 2026-11-22; compared byte for byte).
resource "cloudflare_record" "mail_spf" {
  zone_id = var.cloudflare_zone_id
  name    = var.domain
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
  name    = var.domain
  type    = "TXT"
  content = "\"google-site-verification=C1hm16eOOsqixasFknN0C3KmgnMV8p0OvfHwHKAYKvg\""
  ttl     = 3600
}

# ── Retired: Cloudflare Email Routing (email-routing.tf, #3291/#4374) ──────────────────────────────
#
# Those declarations were gated behind manage_email_routing, which the apply workflow could only
# switch on from a MANAGE_EMAIL_ROUTING key in alethia/prod/env — absent when checked on 2026-11-22 —
# so none of the 11 objects is expected to be in state, and each block below is expected to be a
# no-op. They cover the case the repository cannot rule out: a LOCAL apply that adopted them.
# `destroy = false` makes OpenTofu FORGET such an object instead of destroying it, so no apply makes
# a Cloudflare call for it. (Routing is already disabled, so a destroy would have nothing left to
# switch off; forgetting is still the choice that cannot surprise anyone.)
#
# Keep these until the stack has been applied once after this change; after that they are inert.

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
