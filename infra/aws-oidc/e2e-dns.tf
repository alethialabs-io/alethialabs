# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# #1773 — the STABLE, long-lived public zone the e2e cert path validates against.
#
# ── WHY A ZONE HAS TO EXIST AT ALL ──────────────────────────────────────────────────────────────
#
# ACM DNS validation searches for its CNAME in a PUBLICLY HOSTED zone. Creating a zone is not the
# same as being delegated one: until `e2e.alethialabs.io` is delegated from Cloudflare (which holds
# `alethialabs.io` — kianchau/macy.ns.cloudflare.com), nothing on the public internet resolves a
# name under it, and a certificate can never issue. Measured 2026-08-10, before this stack existed:
#
#   dig NS e2e.alethialabs.io          ->  (empty — not delegated)
#   aws route53 list-hosted-zones      ->  0 zones
#
# That is the whole reason `acm_certificate` is pinned off in test/e2e/maxconfig.go.
#
# ── WHY IT IS STABLE AND LONG-LIVED, NOT PER-RUN ────────────────────────────────────────────────
#
# The obvious alternative — a fresh child zone per run, NS-delegated on the fly — loses to DNS
# caching, and the numbers are not close:
#
#   * The parent answers NXDOMAIN for anything under `e2e.alethialabs.io` today, and a negative
#     answer is cached for min(SOA MINIMUM, SOA TTL). Measured on `alethialabs.io`: both are 1800,
#     so 30 MINUTES. RFC 8020 additionally permits a resolver that saw NXDOMAIN for one name to
#     treat the ENTIRE subtree as nonexistent — including the `_<hash>` validation name.
#   * Terraform creates `aws_acm_certificate` BEFORE the validation record, so ACM begins querying
#     before the name exists. That is exactly the window in which a negative answer gets pinned.
#   * ACM's re-check cadence is undocumented, so there is nothing to design against, and its
#     validation ceiling is 72 hours after which the certificate is DEAD and must be re-requested.
#
# A zone whose name always exists never produces a negative answer to cache. Nothing is rewritten
# per run, so nothing has to propagate mid-run. The cost is one manual delegation, once, ever.
#
# ── WHY NOT A WILDCARD DELEGATION ───────────────────────────────────────────────────────────────
#
# `*.e2e.alethialabs.io NS ...` would have made per-run child zones resolvable with no per-run
# parent edit. Route 53 refuses it outright: "You can't use the * wildcard for resource records
# sets that have a type of NS." Even elsewhere it is unsafe — RFC 4592 §4.2 leaves the semantics of
# a wildcard NS RRSet explicitly UNDEFINED (the synthesis would have the parent fabricate a zone cut
# it never made), and BIND 9 rejects them. Not a technicality; there is no way to publish it.
#
# ── OWNERSHIP ───────────────────────────────────────────────────────────────────────────────────
#
# Applied by the maintainer with an admin identity, like everything else in this stack (invariant 4:
# `tofu apply` on infra/ IAM stacks is maintainer-only; agents never apply). The nightly role does
# NOT create this zone — it only writes records into it, which e2e-nightly.tf already permits via
# `route53:*`. So no IAM change accompanies this file.

resource "aws_route53_zone" "e2e" {
  count = var.e2e_dns_zone_name != "" ? 1 : 0

  name    = var.e2e_dns_zone_name
  comment = "Stable public zone for the T2 nightly's ACM/cert proof (#1773). Delegated from Cloudflare."

  # No `force_destroy`. This zone is long-lived by design and its name servers are referenced by a
  # delegation held in ANOTHER provider's control plane — destroying it silently breaks a record
  # this stack cannot see or repair.
  tags = {
    ManagedBy = "alethia-infra"
    Stack     = "aws-oidc"
    Purpose   = "e2e-cert-validation"
  }
}

# ── The delegation is a MANUAL step, and this is the value it needs ─────────────────────────────
#
# Paste these four name servers into Cloudflare as the NS record set for `e2e.alethialabs.io`. Until
# that is done the zone exists but resolves for nobody, and the cert path stays unprovable.
#
# Verify afterwards with:  dig NS e2e.alethialabs.io   (must return exactly these four)
output "e2e_dns_zone_name_servers" {
  description = "Delegate these at Cloudflare as the NS set for the e2e zone (#1773). Empty when e2e_dns_zone_name is unset."
  value       = length(aws_route53_zone.e2e) > 0 ? aws_route53_zone.e2e[0].name_servers : []
}

output "e2e_dns_zone_id" {
  description = "Hosted zone id for the stable e2e cert zone. Set this as the E2E_AWS_DNS_ZONE_ID repo variable."
  value       = length(aws_route53_zone.e2e) > 0 ? aws_route53_zone.e2e[0].zone_id : ""
}

# ── Invariants ─────────────────────────────────────────────────────────────────────────────────

check "e2e_dns_zone_is_public" {
  assert {
    # A private zone cannot serve ACM validation — ACM reads the PUBLIC internet. Route 53 has no
    # "is public" attribute; a private zone is one with `vpc` associations, which this never sets.
    # Asserted against the rendered resource rather than the variable so a future edit that adds a
    # vpc block trips here instead of at the first failed certificate.
    condition     = length(aws_route53_zone.e2e) == 0 || length(aws_route53_zone.e2e[0].vpc) == 0
    error_message = "the e2e cert zone must be PUBLIC — ACM DNS validation only reads publicly resolvable names, so a VPC association makes the cert path unprovable."
  }
}

check "e2e_dns_zone_is_a_subdomain" {
  assert {
    # Refuse an apex. Delegating the whole of `alethialabs.io` into the e2e account would move
    # production DNS — including the control-plane records the cp-* stacks manage on Cloudflare —
    # into an account whose entire purpose is to be torn down nightly.
    condition     = var.e2e_dns_zone_name == "" || length(split(".", trimsuffix(var.e2e_dns_zone_name, "."))) >= 3
    error_message = "e2e_dns_zone_name must be a SUBDOMAIN (e.g. e2e.alethialabs.io), never an apex — delegating the apex would move production DNS into the e2e account."
  }
}
