# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Loud invariant reports. A `check` WARNS; it does not fail a plan. What must be un-appliable is
# enforced harder: input shapes are variable `validation`s, "inside the zone" is a `precondition` on
# the custom domain, and the bucket carries prevent_destroy (main.tf).

check "zone_is_active_in_the_expected_account" {
  assert {
    condition = alltrue([
      data.cloudflare_zone.this.name == var.zone_name,
      data.cloudflare_zone.this.status == "active",
      data.cloudflare_zone.this.account.id == var.cloudflare_account_id,
    ])
    error_message = "the ${var.zone_name} zone must be active in account ${var.cloudflare_account_id}."
  }
}

check "assets_are_public_only_through_the_custom_domain" {
  assert {
    condition = alltrue([
      cloudflare_r2_custom_domain.assets.enabled,
      cloudflare_r2_custom_domain.assets.domain == var.hostname,
      !cloudflare_r2_managed_domain.assets.enabled,
    ])
    error_message = "the bucket must be reachable at https://${var.hostname} and NOT at its r2.dev URL."
  }
}

check "bucket_is_in_the_eu" {
  assert {
    condition     = cloudflare_r2_bucket.assets.jurisdiction == "eu"
    error_message = "the assets bucket must be in the EU jurisdiction (docs/legal/GDPR_ACCOUNTABILITY.md)."
  }
}
