# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cloudflare Zero-Trust Access for the Umami dashboard (analytics.<domain>). The dashboard UI is
# team-only; the tracker's public endpoints (/script.js + /api) are BYPASSED so the browser tracker
# on alethialabs.io can still fetch the script and POST events. More-specific paths win in Access, so
# the two bypass apps take precedence over the root dashboard app.
#
# ── WHY TWO LOGIN LAYERS (Access + Umami's own login) — deliberate, NOT redundant ──
# The browser tracker must POST events *publicly* to /api/send, so the /api bypass app below is open to
# `everyone`. Umami's ADMIN API lives under the same /api prefix, so it is publicly reachable too —
# which means **Umami's own username/password is the real guard for your analytics DATA**, while
# **Cloudflare Access only gates the dashboard HTML UI**. The two layers protect two DIFFERENT surfaces:
#   * Cloudflare Access -> the dashboard UI (/, HTML)      : stops randoms from reaching the login page
#   * Umami login       -> the admin API (/api/websites..) : the actual data guard (its /api is bypassed)
# Dropping either weakens a distinct surface, so hitting the dashboard prompts twice by design.
# Single-gate alternative (considered, NOT taken — we chose defense-in-depth): set Umami DISABLE_LOGIN=1
# and narrow the /api bypass below from all-of-/api to just /api/send, making Access the sole gate.
#
# Gated on manage_analytics_access (default off) — requires a Cloudflare Zero-Trust org (team domain,
# a one-time dashboard step) and analytics_access_emails to be set. Until then the dashboard is guarded
# by Umami's own login only (admin / UMAMI_ADMIN_PASSWORD — auto-generated, stored in the AWS vault
# alethia/prod/env; never a UI-set value). See deploy/analytics/README.md, section "Dashboard login".

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
