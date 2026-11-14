# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Account-level SES settings. Both resources are PUT calls on the account, not objects with an
# identity: creating them needs no import, and destroying them only resets the setting.

# Virtual Deliverability Manager, as infra/email-ses/vdm.tf: the deliverability dashboard with
# engagement metrics, and Guardian's optimized shared delivery.
resource "aws_sesv2_account_vdm_attributes" "this" {
  vdm_enabled = "ENABLED"

  dashboard_attributes {
    engagement_metrics = "ENABLED"
  }

  guardian_attributes {
    optimized_shared_delivery = "ENABLED"
  }
}

# The account-level suppression list. It is ALREADY set to BOUNCE + COMPLAINT by hand; this records
# that setting so a later console click cannot quietly narrow it. The config sets carry the same
# reasons (config-sets.tf), and a set's own list overrides the account's for sends through it.
resource "aws_sesv2_account_suppression_attributes" "this" {
  suppressed_reasons = ["BOUNCE", "COMPLAINT"]
}
