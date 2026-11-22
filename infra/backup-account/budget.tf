# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The account's cost alarm. Every dollar in this account is backups, so the budget measures exactly
# the thing it guards: a breach means a drill instance that did not terminate, or storage that is
# not expiring. Email subscribers directly (no SNS topic: AWS Budgets cannot publish to a
# CMK-encrypted topic, see infra/aws-e2e/e2e-budget.tf).

resource "aws_budgets_budget" "backup" {
  name         = "alethia-backup-monthly"
  budget_type  = "COST"
  limit_amount = format("%d", var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = toset([50, 100])
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = var.budget_alert_emails
    }
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.budget_alert_emails
  }
}
