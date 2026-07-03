# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The least-privilege deploy role for the main SES stack. Assumed by GitHub
# Actions via OIDC (no stored keys) and, optionally, by an admin principal for
# local import/apply. Its policy grants exactly what `tofu apply` of the main
# stack + verify.sh need — and no iam:* at all.

data "aws_iam_policy_document" "deployer_trust" {
  statement {
    sid     = "GithubOIDC"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/${var.github_branch}"]
    }
  }

  # Optional: let an admin principal assume the role for local import/apply.
  dynamic "statement" {
    for_each = length(var.admin_principal_arns) > 0 ? [1] : []
    content {
      sid     = "AdminAssume"
      effect  = "Allow"
      actions = ["sts:AssumeRole"]
      principals {
        type        = "AWS"
        identifiers = var.admin_principal_arns
      }
    }
  }
}

resource "aws_iam_role" "deployer" {
  name               = "alethia-ses-deployer"
  description        = "Least-privilege deploy role for the email-ses OpenTofu stack."
  assume_role_policy = data.aws_iam_policy_document.deployer_trust.json
  tags               = local.tags
}

# Least-privilege permissions — scoped by resource where the service supports it,
# otherwise tightened by action. No iam:* (all IAM is here in bootstrap).
data "aws_iam_policy_document" "deployer_permissions" {
  # SES is largely account/identity-scoped with weak resource-level support, so
  # this is tightened by action. Covers identities, DKIM, MAIL FROM, config sets +
  # event destinations, VDM, production-access request, and sending (verify.sh).
  statement {
    sid    = "SES"
    effect = "Allow"
    actions = [
      "ses:GetAccount",
      "ses:PutAccountVdmAttributes",
      "ses:PutAccountDetails",
      "ses:ListEmailIdentities",
      "ses:CreateEmailIdentity",
      "ses:DeleteEmailIdentity",
      "ses:GetEmailIdentity",
      "ses:TagResource",
      "ses:UntagResource",
      "ses:PutEmailIdentityMailFromAttributes",
      "ses:PutEmailIdentityDkimSigningAttributes",
      "ses:PutEmailIdentityDkimAttributes",
      "ses:ListConfigurationSets",
      "ses:CreateConfigurationSet",
      "ses:DeleteConfigurationSet",
      "ses:GetConfigurationSet",
      "ses:GetConfigurationSetEventDestinations",
      "ses:CreateConfigurationSetEventDestination",
      "ses:UpdateConfigurationSetEventDestination",
      "ses:DeleteConfigurationSetEventDestination",
      "ses:SendEmail",
      "ses:SendRawEmail",
    ]
    resources = ["*"]
  }

  # SNS — events + alarms topics (created by the main stack), scoped by name.
  statement {
    sid    = "SNS"
    effect = "Allow"
    actions = [
      "sns:CreateTopic",
      "sns:DeleteTopic",
      "sns:GetTopicAttributes",
      "sns:SetTopicAttributes",
      "sns:ListTagsForResource",
      "sns:TagResource",
      "sns:UntagResource",
      "sns:Subscribe",
      "sns:Unsubscribe",
      "sns:GetSubscriptionAttributes",
      "sns:SetSubscriptionAttributes",
      "sns:ListSubscriptionsByTopic",
    ]
    resources = ["arn:aws:sns:${local.region}:${local.account_id}:alethia-ses-*"]
  }

  # CloudWatch reputation alarms, scoped by name.
  statement {
    sid    = "CloudWatchAlarms"
    effect = "Allow"
    actions = [
      "cloudwatch:PutMetricAlarm",
      "cloudwatch:DeleteAlarms",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:ListTagsForResource",
      "cloudwatch:TagResource",
      "cloudwatch:UntagResource",
    ]
    resources = ["arn:aws:cloudwatch:${local.region}:${local.account_id}:alarm:alethia-ses-*"]
  }

  # verify.sh captures events through a throwaway queue.
  statement {
    sid    = "VerifyCaptureQueue"
    effect = "Allow"
    actions = [
      "sqs:CreateQueue",
      "sqs:DeleteQueue",
      "sqs:GetQueueAttributes",
      "sqs:SetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
    ]
    resources = ["arn:aws:sqs:${local.region}:${local.account_id}:alethia-ses-verify-*"]
  }

  # OpenTofu state — the deploy role authenticates the S3 backend itself (same
  # account), so no static state keys are needed. ListBucket on the bucket +
  # object RW (state object + the native .tflock lock object).
  statement {
    sid       = "TofuStateBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketVersioning"]
    resources = ["arn:aws:s3:::${var.state_bucket_name}"]
  }
  statement {
    sid       = "TofuStateObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${var.state_bucket_name}/*"]
  }
}

resource "aws_iam_role_policy" "deployer" {
  name   = "alethia-ses-deploy"
  role   = aws_iam_role.deployer.id
  policy = data.aws_iam_policy_document.deployer_permissions.json
}
