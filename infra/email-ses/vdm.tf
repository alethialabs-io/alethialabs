# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Virtual Deliverability Manager — account-level deliverability dashboard +
# engagement metrics and Guardian's optimized shared delivery.

resource "aws_sesv2_account_vdm_attributes" "this" {
  vdm_enabled = "ENABLED"

  dashboard_attributes {
    engagement_metrics = "ENABLED"
  }

  guardian_attributes {
    optimized_shared_delivery = "ENABLED"
  }
}
