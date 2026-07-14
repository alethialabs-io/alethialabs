# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# BYOC A1.1 — cost kill-signal for the e2e nightly. A monthly AWS Budget + an SNS topic:
# the Budget alerts at 50/80/100% of e2e_monthly_budget_usd (actual) + 100% forecast, both
# by direct email AND onto the SNS topic (so a maintainer can later hang an automated
# account kill-switch off it). A safety net on top of the always()-teardown — the nightly is
# a single tiny ephemeral cluster, so real spend should sit far under the ceiling; a breach
# means a leak or a stuck run.
#
# Budgets is a GLOBAL service homed in us-east-1 and can only publish to a us-east-1 SNS
# topic, so everything here uses the `aws.useast1` aliased provider (versions.tf).

# The SNS topic is deliberately UNENCRYPTED: AWS Budgets publishes via the AWS-managed
# principal budgets.amazonaws.com, which cannot use a customer CMK-encrypted topic, and the
# AWS-managed `alias/aws/sns` key does not grant Budgets kms:GenerateDataKey — either would
# silently DROP the very cost alerts this exists to deliver. The payload is a non-sensitive
# cost figure. (Trivy AVD-AWS-0095 suppressed in infra/.trivyignore with this rationale.)
resource "aws_sns_topic" "e2e_budget" {
  provider = aws.useast1
  name     = "alethia-e2e-nightly-budget-alerts"
  tags     = local.tags
}

# Let AWS Budgets (and only this account's) publish to the topic.
data "aws_iam_policy_document" "e2e_budget_topic" {
  statement {
    sid     = "AllowBudgetsPublish"
    effect  = "Allow"
    actions = ["SNS:Publish"]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }
    resources = [aws_sns_topic.e2e_budget.arn]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "e2e_budget" {
  provider = aws.useast1
  arn      = aws_sns_topic.e2e_budget.arn
  policy   = data.aws_iam_policy_document.e2e_budget_topic.json
}

# Email subscribers (each confirms via the SNS opt-in email). Empty list ⇒ topic only.
resource "aws_sns_topic_subscription" "e2e_budget_email" {
  for_each = toset(var.e2e_budget_alert_emails)

  provider  = aws.useast1
  topic_arn = aws_sns_topic.e2e_budget.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_budgets_budget" "e2e_nightly" {
  provider     = aws.useast1
  name         = "alethia-e2e-nightly"
  budget_type  = "COST"
  limit_amount = format("%d", var.e2e_monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Actual-spend alerts at 50 / 80 / 100 %.
  dynamic "notification" {
    for_each = toset([50, 80, 100])
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_sns_topic_arns  = [aws_sns_topic.e2e_budget.arn]
      subscriber_email_addresses = var.e2e_budget_alert_emails
    }
  }

  # Forecast alert at 100 % — warns before the ceiling is actually hit.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_sns_topic_arns  = [aws_sns_topic.e2e_budget.arn]
    subscriber_email_addresses = var.e2e_budget_alert_emails
  }
}
