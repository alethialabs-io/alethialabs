# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# DNS-zone invariants (see dns.tf).
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

# WARN companion to the fail-closed guard below — a `check` states the violation at plan, it
# never blocks (that is what #1734/#1716 taught: a bare check is a note, not a gate).
check "dns_domain_present_when_enabled" {
  assert {
    condition     = !var.cloud_dns_enabled || length(trimspace(var.dns_main_domain)) > 0
    error_message = "cloud_dns_enabled is true but dns_main_domain is empty; hcloud_zone.name would be empty and the Hetzner API would reject it mid-apply."
  }
}

# Fail-closed. `hcloud_zone.name` is required and validated server-side, so an empty domain is a
# 4xx DEEP in apply — after the network, the servers and the Talos bootstrap already exist.
# A lifecycle precondition moves that to a hard plan-time block, which is the only thing tofu
# offers that actually refuses.
resource "terraform_data" "dns_zone_guard" {
  lifecycle {
    precondition {
      condition     = !var.cloud_dns_enabled || length(trimspace(var.dns_main_domain)) > 0
      error_message = "cloud_dns_enabled is true but dns_main_domain is empty. Supply the apex domain for the zone (e.g. example.com), or turn DNS off. Apply blocked fail-closed."
    }
  }
}
