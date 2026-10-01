# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The E2E assertion issuer's public origin (#4226, maintainer ruling 2026-09-23): the Worker
# `alethia-e2e-issuer` (apps/e2e-issuer) served at https://e2e-issuer.alethialabs.io through a
# Cloudflare Workers Custom Domain, plus a CAA record set on that host. The Worker's CODE is deployed
# by .github/workflows/deploy-e2e-issuer.yml with a separate token; this stack owns only where it is
# reachable, and never deploys a script.
#
# Applied by the maintainer only, with a zone-scoped token. See README.md for the runbook and the
# ordering it depends on.

locals {
  # The Worker's name has ONE copy: apps/e2e-issuer/wrangler.jsonc, which is what wrangler deploys.
  # Read it rather than restate it, the same way the four trust stacks read broker.ts — a renamed
  # Worker then changes this plan instead of attaching the domain to a script that no longer exists.
  # A moved file or a changed shape makes `regex` fail and the plan error before anything applies.
  wrangler_config = file("${path.module}/../../apps/e2e-issuer/wrangler.jsonc")
  worker_name     = regex("(?m)^  \"name\"\\s*:\\s*\"([^\"]+)\"", local.wrangler_config)[0]

  # No path, no port, no trailing slash — by construction. The Worker refuses any other shape
  # (normalizedIssuer() in apps/e2e-issuer/src/worker.ts), and every cloud compares `iss` byte for byte.
  issuer_url = "https://${var.hostname}"

  # ── CAA: which CAs may issue for this host ──────────────────────────────────────────────────────
  #
  # The ruling asked for ONE CA. On this zone that is not achievable, and the reason is Cloudflare's
  # documented behaviour, not a preference (developers.cloudflare.com/ssl/edge-certificates/caa-records/,
  # read 2026-09-23):
  #
  #   1. "Cloudflare adds CAA records automatically when you have Universal SSL and add any CAA records
  #      to your zone" — for pki.goog, letsencrypt.org, ssl.com and sectigo.com, and "this list is not
  #      exhaustive". Those injected records are served but do NOT appear in the dashboard or the API.
  #      A one-CA record set here would be answered as a four-CA set anyway, so a one-CA plan would be
  #      a statement the live DNS contradicts.
  #   2. A Workers Custom Domain "will also generate an Advanced Certificate ... with default settings"
  #      (developers.cloudflare.com/workers/configuration/routing/custom-domains/). Which CA those
  #      defaults choose is not documented, and choosing one means deleting that certificate and
  #      ordering an Advanced Certificate Manager certificate (a paid add-on). If a CAA set excluded the
  #      CA Cloudflare picks, issuance or a RENEWAL would fail and the issuer would go dark on expiry.
  #   3. Even one CA is not one chain: GTS and Let's Encrypt both issue from several intermediates.
  #
  # So this pins the ONLY set Cloudflare can issue from for this host, and writes it down rather than
  # leaving it to invisible injection. It is still a real restriction: every other public CA is
  # refused. What actually protects the Alibaba trust against a chain change is the committed
  # fingerprint pin (tls-ca-pin.json) plus the scheduled health check that compares it with the live
  # chain — see README.md "Why there is no single-CA pin".
  #
  # NOT covered, and cannot be from here: a wildcard certificate for *.alethialabs.io would also cover
  # this host, and CAA for a wildcard is looked up at the zone apex (RFC 8659 §3), which carries no CAA
  # record today. That is a zone-wide decision recorded as a follow-up in README.md, not taken here.
  caa_issuers = toset([
    "pki.goog",        # Google Trust Services
    "letsencrypt.org", # Let's Encrypt
    "ssl.com",         # SSL.com
    "sectigo.com",     # Sectigo — Cloudflare's backup-certificate CA
  ])
}

# Looked up by NAME and filtered by ACCOUNT, so the id is never hand-copied and a same-named zone in
# another account cannot be matched. Needs Zone:Read on this zone (README.md, the token).
data "cloudflare_zone" "this" {
  filter = {
    name    = var.zone_name
    account = { id = var.cloudflare_account_id }
  }
}

# Binds the host to the Worker. Cloudflare creates the host's DNS record itself (it is not a
# record this stack or anyone may edit) and issues an Advanced Certificate for it. Two documented
# constraints the runbook orders around: the Worker must already EXIST (it does — deploy-e2e-issuer
# has deployed it), and the host must have no CNAME already.
resource "cloudflare_workers_custom_domain" "issuer" {
  account_id = var.cloudflare_account_id
  zone_id    = data.cloudflare_zone.this.zone_id
  hostname   = var.hostname
  service    = local.worker_name

  lifecycle {
    # Un-appliable, not merely noisy (a `check` only warns): a host outside the zone cannot be bound
    # to it, and one inside the Route53-delegated subzone would bind a name nobody can resolve.
    precondition {
      condition     = endswith(var.hostname, ".${var.zone_name}")
      error_message = "hostname ${var.hostname} is not a subdomain of ${var.zone_name}."
    }
    precondition {
      condition     = !endswith(var.hostname, ".e2e.${var.zone_name}")
      error_message = "hostname ${var.hostname} is inside e2e.${var.zone_name}, which is delegated to Route53."
    }
    precondition {
      condition     = can(regex("^https://[a-z0-9.-]+$", local.issuer_url))
      error_message = "the issuer URL must be a bare https origin with no path, port or trailing slash — got ${local.issuer_url}."
    }
  }
}

resource "cloudflare_dns_record" "caa" {
  for_each = local.caa_issuers

  zone_id = data.cloudflare_zone.this.zone_id
  name    = var.hostname
  type    = "CAA"
  ttl     = 1 # automatic
  comment = "e2e issuer (#4226): the CAs Cloudflare may issue from for this host — infra/e2e-issuer"
  data = {
    flags = 0
    tag   = "issue"
    value = each.value
  }
}
