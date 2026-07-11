# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# Creates and manages a Route 53 public hosted zone in-template, giving AWS parity with the
# GCP (google_dns_managed_zone) and Azure (azurerm_dns_zone) templates, which already create
# their managed zone. Used only when the caller wants Alethia to own the zone; otherwise the
# root template passes an existing zone id via var.dns_hosted_zone.

resource "aws_route53_zone" "zone" {
  name    = var.domain
  comment = "Managed DNS zone for ${var.domain} (${var.environment})"

  tags = merge(var.tags, {
    Name = var.zone_name != "" ? var.zone_name : var.domain
  })
}
