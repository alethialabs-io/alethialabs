# CloudWatch Logging Configuration - Define the CloudWatch log group
resource "aws_cloudwatch_log_group" "wafv2-cloudwatch-log-group" {
  count             = var.aws_waf_logging_enabled ? 1 : 0
  name              = "aws-waf-logs-${var.project}-${var.env}-${var.waf_attachment_type}-security"
  retention_in_days = var.waf_log_retention_days
}

# WAFv2 Web ACL Logging Configuration - Associate the CloudWatch log group with the WAFv2 web ACL
resource "aws_wafv2_web_acl_logging_configuration" "wafv2-logging-configs" {
  count                   = var.aws_waf_logging_enabled ? 1 : 0
  log_destination_configs = [aws_cloudwatch_log_group.wafv2-cloudwatch-log-group[count.index].arn]
  resource_arn            = length(aws_wafv2_web_acl.wafv2_web_acl) > 0 ? aws_wafv2_web_acl.wafv2_web_acl[count.index].arn : "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:placeholder_arn_when_count_is_0"
}

# CloudWatch Log Resource Policy - Define the policy to allow CloudWatch logs
resource "aws_cloudwatch_log_resource_policy" "wafv2-resource-policy" {
  count           = var.aws_waf_logging_enabled ? 1 : 0
  policy_document = data.aws_iam_policy_document.wafv2-cloudwatch-iam-policy[count.index].json
  policy_name     = "${var.project}-${var.env}-${var.waf_attachment_type}-security-cloudwatch-policy"
}

data "aws_iam_policy_document" "wafv2-cloudwatch-iam-policy" {
  count   = var.aws_waf_logging_enabled ? 1 : 0
  version = "2012-10-17"
  statement {
    effect = "Allow"
    principals {
      identifiers = ["delivery.logs.amazonaws.com"]
      type        = "Service"
    }
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [aws_cloudwatch_log_group.wafv2-cloudwatch-log-group[count.index].arn]
    condition {
      test     = "ArnLike"
      values   = ["arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"]
      variable = "aws:SourceArn"
    }
    condition {
      test     = "StringEquals"
      values   = [tostring(data.aws_caller_identity.current.account_id)]
      variable = "aws:SourceAccount"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
