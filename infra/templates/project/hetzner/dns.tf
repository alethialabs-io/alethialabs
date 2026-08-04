# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# In-template hcloud DNS zone — parity with aws/route53.tf, gcp/cloud-dns.tf and
# azure/azure-dns.tf, which each create their managed zone.
#
# Until #1816 this file did not exist. The canvas offered a DNS component on Hetzner, the
# console carried nothing to the plan, and the component built NOTHING — the exact silence
# the cloud-parity rule forbids. It is a build rather than an exclusion because Hetzner does
# sell DNS: zones live on the Cloud API, project-scoped, authenticated by the same
# HCLOUD_TOKEN this template already uses, and the pinned hcloud provider exposes them
# natively (`hcloud_zone`, GA at provider 1.56 — hence the floor raised in main.tf).
#
# NOT to be confused with the two Hetzner DNS cells that ARE excluded: a managed certificate
# is issued in-cluster by cert-manager and Hetzner sells no WAF at all. Those are ceilings.
# This one was just missing.

resource "hcloud_zone" "this" {
  # Create the zone only when the user wants Alethia to own it (the console sets this when DNS
  # is on AND no existing zone id was supplied) and DNS is cloud-native rather than delegated
  # to a pluggable connector such as Cloudflare.
  count = var.cloud_dns_enabled && var.dns_provider == "native" ? 1 : 0

  # hcloud stores zone names without a trailing dot; the canvas may carry either form.
  name = trimsuffix(trimspace(var.dns_main_domain), ".")
  mode = "primary"
  ttl  = var.dns_zone_ttl

  labels = local.default_labels
}
