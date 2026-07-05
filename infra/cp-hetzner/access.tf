# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cloudflare Zero-Trust Access for the Umami dashboard (analytics.<domain>). The dashboard UI is
# team-only; the tracker's public endpoints (/script.js + /api) are BYPASSED so the browser tracker
# on alethialabs.io can still fetch the script and POST events. More-specific paths win in Access, so
# the two bypass apps take precedence over the root dashboard app.
#
# Gated on manage_analytics_access (default off) — requires a Cloudflare Zero-Trust org (team domain,
# a one-time dashboard step) and analytics_access_emails to be set. Until then the dashboard is guarded
# by Umami's own login (rotate the admin/umami default).

locals {
  analytics_host = "analytics.${var.domain}"
  access_count   = var.manage_analytics_access ? 1 : 0
}

# ── Bypass: tracker script (public GET) ──────────────────────────────────────────
resource "cloudflare_zero_trust_access_application" "umami_script" {
  count            = local.access_count
  zone_id          = var.cloudflare_zone_id
  name             = "Umami tracker script"
  domain           = "${local.analytics_host}/script.js"
  type             = "self_hosted"
  session_duration = "24h"
}

resource "cloudflare_zero_trust_access_policy" "umami_script_bypass" {
  count          = local.access_count
  application_id = cloudflare_zero_trust_access_application.umami_script[0].id
  zone_id        = var.cloudflare_zone_id
  name           = "bypass — tracker script is public"
  precedence     = 1
  decision       = "bypass"
  include {
    everyone = true
  }
}

# ── Bypass: ingest + Umami's own API (public POST /api/send; reads still need Umami auth) ──
resource "cloudflare_zero_trust_access_application" "umami_api" {
  count            = local.access_count
  zone_id          = var.cloudflare_zone_id
  name             = "Umami ingest (/api)"
  domain           = "${local.analytics_host}/api"
  type             = "self_hosted"
  session_duration = "24h"
}

resource "cloudflare_zero_trust_access_policy" "umami_api_bypass" {
  count          = local.access_count
  application_id = cloudflare_zero_trust_access_application.umami_api[0].id
  zone_id        = var.cloudflare_zone_id
  name           = "bypass — ingest is public (Umami guards its own reads)"
  precedence     = 1
  decision       = "bypass"
  include {
    everyone = true
  }
}

# ── Dashboard: team-only ─────────────────────────────────────────────────────────
resource "cloudflare_zero_trust_access_application" "umami_dashboard" {
  count            = local.access_count
  zone_id          = var.cloudflare_zone_id
  name             = "Umami dashboard"
  domain           = local.analytics_host
  type             = "self_hosted"
  session_duration = "24h"
}

resource "cloudflare_zero_trust_access_policy" "umami_dashboard_allow" {
  count          = local.access_count
  application_id = cloudflare_zero_trust_access_application.umami_dashboard[0].id
  zone_id        = var.cloudflare_zone_id
  name           = "team only"
  precedence     = 1
  decision       = "allow"
  include {
    email = var.analytics_access_emails
  }
}
