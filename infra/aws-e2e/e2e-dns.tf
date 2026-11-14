# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The stable public zone the T2 ACM/cert proof validates against (#1773), re-homed. Why a stable zone
# rather than one per run, and why not a wildcard delegation: infra/aws-oidc/e2e-dns.tf.
#
# ── TWO ZONES OF THE SAME NAME, ON PURPOSE ──────────────────────────────────────────────────────
#
# Route 53 allows a public zone named e2e.alethialabs.io in this account while the old one still
# exists in the platform account; each gets its own four name servers. Which one the internet asks is
# decided by ONE thing — the NS record set for `e2e` at Cloudflare. So the move is:
#
#   create this zone  →  re-point the Cloudflare NS set at its four servers  →  prove ACM issues
#   →  only then remove the old zone (a later PR, in infra/aws-oidc)
#
# and the rollback at every step is re-pointing the Cloudflare NS set back at the old four, which are
# untouched by this PR. The old zone holds no record worth copying: measured 2026-11-14 it holds 296
# record sets, every one a per-run external-dns leftover (argocd.<run>.e2e…, TXT ownership markers)
# for clusters long destroyed, plus its NS and SOA.
#
# ── WHY THE APEX NS TTL IS MANAGED ───────────────────────────────────────────────────────────────
#
# Measured 2026-11-14: Cloudflare serves the delegation at TTL 300, but the old zone's own apex NS
# record is 172800 (Route 53's default), and resolvers prefer the child's authoritative copy. So after
# a re-delegation a resolver can keep asking the OLD zone for up to 48 hours. `e2e_dns_ns_ttl` sets
# this zone's apex NS to 300, so that a later rollback (or the next move) lands in minutes. It cannot
# shorten the cutover TO this zone — that is governed by the OLD zone's 172800; see README step 5.
#
# Applied by the maintainer only. The nightly role writes records into this zone (route53:*) and
# creates nothing at this level.

resource "aws_route53_zone" "e2e" {
  name    = var.e2e_dns_zone_name
  comment = "Stable public zone for the T2 nightly's ACM/cert proof (#1773), dedicated e2e account. Delegated from Cloudflare."

  # No force_destroy, and prevent_destroy: its name servers are referenced by a delegation in another
  # provider's control plane, which this stack cannot see or repair. Removing it is a code edit.
  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Purpose = "e2e-cert-validation"
  }
}

# The zone's own apex NS record, adopted (allow_overwrite) only to lower its TTL. Records are the
# zone's assigned name servers, read back from the zone, so this can never point the zone elsewhere.
resource "aws_route53_record" "e2e_apex_ns" {
  allow_overwrite = true
  zone_id         = aws_route53_zone.e2e.zone_id
  name            = aws_route53_zone.e2e.name
  type            = "NS"
  ttl             = var.e2e_dns_ns_ttl
  records         = aws_route53_zone.e2e.name_servers
}
