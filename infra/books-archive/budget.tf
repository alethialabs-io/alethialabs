# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# This stack's cost alarm. The account also holds the backups (infra/backup-account, budget USD 15),
# so an unfiltered USD 5 budget here would fire on the backups' spend every month. It is scoped to
# this stack's resources by the `role = books-archive` default tag (provider.tf).
#
# PRECONDITION OUTSIDE THIS STACK: a tag filter only sees costs once `role` is an ACTIVE cost
# allocation tag in the organization's PAYER account (Billing → Cost allocation tags). Until it is,
# this budget reads USD 0 and never fires — README "Cost" says how to activate it and how to confirm.
# Email subscribers directly (no SNS topic: AWS Budgets cannot publish to a CMK-encrypted topic).

resource "aws_budgets_budget" "archive" {
  name         = "alethia-books-archive-monthly"
  budget_type  = "COST"
  limit_amount = format("%d", var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name = "TagKeyValue"
    # AWS's form is user:<key>$<value>. format(), because "$${" in an HCL string is an escape that
    # would emit the interpolation literally.
    values = [format("user:role$%s", local.cost_tag_value)]
  }

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
