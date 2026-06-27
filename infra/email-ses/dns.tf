# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cloudflare DNS for SES — Terraform is the source of truth so records never
# drift. DKIM CNAMEs (3 per identity), the MAIL FROM MX + SPF per stream, and
# one DMARC policy for the root domain.
#
# NOTE: DKIM tokens aren't known until the identity is created, so for_each keys
# are the stable "<stream>-<0..2>" — the unknown token is only the record value.
# If these records already exist (DNS was set up by hand), `tofu import` them
# first (see README) so the plan is additive.

locals {
  # 3 DKIM records per stream, keyed by a plan-time-known "<stream>-<idx>".
  dkim_records = merge([
    for sk, s in var.streams : {
      for i in range(3) : "${sk}-${i}" => { stream = sk, idx = i }
    }
  ]...)
}

resource "cloudflare_record" "dkim" {
  for_each = local.dkim_records

  zone_id = var.cloudflare_zone_id
  name    = "${aws_sesv2_email_identity.stream[each.value.stream].dkim_signing_attributes[0].tokens[each.value.idx]}._domainkey.${var.streams[each.value.stream].subdomain}"
  type    = "CNAME"
  content = "${aws_sesv2_email_identity.stream[each.value.stream].dkim_signing_attributes[0].tokens[each.value.idx]}.dkim.amazonses.com"
  proxied = false
  ttl     = 300
  comment = "SES DKIM (${each.value.stream})"
}

resource "cloudflare_record" "mail_from_mx" {
  for_each = var.streams

  zone_id  = var.cloudflare_zone_id
  name     = "bounce.${each.value.subdomain}"
  type     = "MX"
  content  = "feedback-smtp.${var.aws_region}.amazonses.com"
  priority = 10
  ttl      = 300
  comment  = "SES MAIL FROM (${each.key})"
}

resource "cloudflare_record" "mail_from_spf" {
  for_each = var.streams

  zone_id = var.cloudflare_zone_id
  name    = "bounce.${each.value.subdomain}"
  type    = "TXT"
  content = "v=spf1 include:amazonses.com ~all"
  ttl     = 300
  comment = "SES MAIL FROM SPF (${each.key})"
}

resource "cloudflare_record" "dmarc" {
  zone_id = var.cloudflare_zone_id
  name    = "_dmarc"
  type    = "TXT"
  # fo=1 → request a failure report when any check fails (matches the live record).
  content = "v=DMARC1; p=${var.dmarc_policy}; rua=${var.dmarc_rua}; fo=1"
  ttl     = 300
  comment = "DMARC policy for ${var.domain}"
}
