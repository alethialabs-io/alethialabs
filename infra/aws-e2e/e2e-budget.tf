# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The e2e cost kill-signal, re-homed. Same shape as infra/aws-oidc/e2e-budget.tf, and STRONGER for
# being here: in the shared account the budget counted every service the platform runs, so an e2e
# leak hid inside prod spend; in the dedicated account every dollar is e2e, so the budget measures
# exactly the thing it guards.
#
# The SNS topic is deliberately UNENCRYPTED (AVD-AWS-0095, accepted in infra/.trivyignore): AWS
# Budgets cannot publish to a CMK-encrypted topic, and alias/aws/sns does not grant it
# kms:GenerateDataKey — either would silently drop the alerts. The payload is a cost figure.
# The nightly role cannot unsubscribe or delete it (DenyTamperWithCostGuard, e2e-nightly.tf).

resource "aws_sns_topic" "e2e_budget" {
  provider = aws.useast1
  name     = local.budget_topic_name
}

data "aws_iam_policy_document" "e2e_budget_topic" {
  statement {
    sid     = "AllowBudgetsPublish"
    effect  = "Allow"
    actions = ["SNS:Publish"]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }
    # The BUILT ARN (e2e-nightly.tf), not aws_sns_topic.e2e_budget.arn: a document that depends on a
    # resource being created is read only at apply, so the first plan would show this policy as
    # `(known after apply)`. check.e2e_budget_topic_arn_matches compares the two once both are known.
    resources = [local.budget_topic_arn]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.e2e_account_id]
    }
  }
}

resource "aws_sns_topic_policy" "e2e_budget" {
  provider = aws.useast1
  arn      = aws_sns_topic.e2e_budget.arn
  policy   = data.aws_iam_policy_document.e2e_budget_topic.json
}

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

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_sns_topic_arns  = [aws_sns_topic.e2e_budget.arn]
    subscriber_email_addresses = var.e2e_budget_alert_emails
  }
}
