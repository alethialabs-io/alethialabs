# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cost kill-signal for the e2e nightly — the Azure analogue of infra/aws-oidc/e2e-budget.tf. A monthly
# subscription consumption budget alerts at 50/80/100% (actual) + 100% (forecast) of
# e2e_monthly_budget_usd, notifying the alert emails directly AND via an action group (so a maintainer
# can later hang an automated kill-switch — e.g. a Logic App that disables the SP — off the group). A
# safety net on top of the always()-teardown: the nightly is a single tiny ephemeral AKS cluster, so
# real spend should sit far under the ceiling; a breach means a leak or a stuck run.

# A tiny resource group homing the stack's own metadata (the action group must live in an RG). Its
# name embeds the prefix so it is trivially auditable and never collides with an e2e RUN's
# rg-<project>-<env> (which the azure-cleanup.sh sweeper targets).
resource "azurerm_resource_group" "meta" {
  name     = "${var.name_prefix}-meta"
  location = var.location
}

resource "azurerm_monitor_action_group" "e2e_budget" {
  name                = "${var.name_prefix}-budget"
  resource_group_name = azurerm_resource_group.meta.name
  short_name          = "e2ebudget" # <= 12 chars

  dynamic "email_receiver" {
    for_each = toset(var.e2e_budget_alert_emails)
    content {
      name          = "email-${substr(md5(email_receiver.value), 0, 8)}"
      email_address = email_receiver.value
    }
  }
}

locals {
  # Budgets require a first-of-month RFC3339 start. Derive it from the apply time and ignore drift on
  # the time_period (see lifecycle below) so the churn doesn't force perpetual updates.
  budget_start_date = formatdate("YYYY-MM-01'T'00:00:00Z", timestamp())
}

resource "azurerm_consumption_budget_subscription" "e2e" {
  name            = "${var.name_prefix}-nightly"
  subscription_id = data.azurerm_subscription.current.id
  amount          = var.e2e_monthly_budget_usd
  time_grain      = "Monthly"

  time_period {
    start_date = local.budget_start_date
  }

  # Actual-spend alerts at 50 / 80 / 100 %.
  dynamic "notification" {
    for_each = toset([50, 80, 100])
    content {
      enabled        = true
      threshold      = notification.value
      operator       = "GreaterThan"
      threshold_type = "Actual"
      contact_emails = var.e2e_budget_alert_emails
      contact_groups = [azurerm_monitor_action_group.e2e_budget.id]
    }
  }

  # Forecast alert at 100 % — warns before the ceiling is actually hit.
  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThan"
    threshold_type = "Forecasted"
    contact_emails = var.e2e_budget_alert_emails
    contact_groups = [azurerm_monitor_action_group.e2e_budget.id]
  }

  lifecycle {
    # start_date is derived from apply time (first-of-month); ignore its churn after creation.
    ignore_changes = [time_period]
  }
}
