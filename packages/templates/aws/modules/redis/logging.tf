locals {

  firehose_role_name            = format("role-%s", local.resource_tag)
  firehose_s3_policy_name       = format("policy-firehose-s3-%s", local.resource_tag)
  firehose_delivery_stream_name = format("firehose-%s", local.resource_tag)
  cloudwatch_log_group_name     = format("/aws/redis/redis-%s", local.resource_tag)
  s3_logs_prefix = format("elasticachelogs/AWSLogs/%s/RedisLogs/%s/",
    data.aws_caller_identity.current.account_id,
  data.aws_region.current.name)

  redis_log_delivery_cloudwatch_configuration = !var.cloudwatch_logs_enabled ? [] : [
    {
      destination      = aws_cloudwatch_log_group.redis[0].name
      destination_type = "cloudwatch-logs"
      log_format       = var.log_format
      log_type         = "slow-log"
    },
    {
      destination      = aws_cloudwatch_log_group.redis[0].name
      destination_type = "cloudwatch-logs"
      log_format       = var.log_format
      log_type         = "engine-log"
    }
  ]

  redis_log_delivery_firehose_configuration = !var.firehose_logs_enabled ? [] : [
    {
      destination      = aws_kinesis_firehose_delivery_stream.redis[0].name
      destination_type = "kinesis-firehose"
      log_format       = var.log_format
      log_type         = "slow-log"
    },
    {
      destination      = aws_kinesis_firehose_delivery_stream.redis[0].name
      destination_type = "kinesis-firehose"
      log_format       = var.log_format
      log_type         = "engine-log"
    }
  ]

  opinionated_log_delivery_configuration = (var.cloudwatch_logs_enabled ?
    local.redis_log_delivery_cloudwatch_configuration :
    local.redis_log_delivery_firehose_configuration
  )

  log_delivery_configuration = (length(var.log_delivery_configuration) > 0 ?
    var.log_delivery_configuration :
    local.opinionated_log_delivery_configuration
  )

}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

data "aws_s3_bucket" "engine_logs" {
  count  = var.s3_logs_enabled ? 1 : 0
  bucket = var.s3_log_bucket_name
}

#tfsec:ignore:aws-cloudwatch-log-group-customer-key
resource "aws_cloudwatch_log_group" "redis" {
  count             = var.cloudwatch_logs_enabled ? 1 : 0
  name              = local.cloudwatch_log_group_name
  retention_in_days = var.cloudwatch_log_group_retention_in_days
}

# https://docs.aws.amazon.com/firehose/latest/dev/controlling-access.html#using-iam-s3
data "aws_iam_policy_document" "firehose_s3_policy" {
  count = var.s3_logs_enabled ? 1 : 0
  statement {
    sid = "AllowBucketSync"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
      "s3:PutObject",
    ]
    effect = "Allow"
    resources = [
      data.aws_s3_bucket.engine_logs[0].arn,
      format("%s/*", data.aws_s3_bucket.engine_logs[0].arn)
    ]
  }
}

# Create cluster scoped tenant policy
resource "aws_iam_policy" "s3_firehose_policy" {
  count       = var.s3_logs_enabled ? 1 : 0
  name        = local.firehose_s3_policy_name
  description = format("Policy to allow kinesis firehose to write to destination s3 bucket for redis cluster %s", module.redis.id)
  policy      = data.aws_iam_policy_document.firehose_s3_policy[0].json
}

resource "aws_iam_role" "firehose_role" {
  count = var.firehose_logs_enabled ? 1 : 0
  name  = local.firehose_role_name

  assume_role_policy = jsonencode({
    "Version" : "2012-10-17",
    "Statement" : [
      {
        Action : "sts:AssumeRole",
        Principal : {
          "Service" : "firehose.amazonaws.com"
        },
        Effect : "Allow",
        Sid : ""
      }
    ]
  })

}

# Associate tenant IAM policy to relevant role
resource "aws_iam_role_policy_attachment" "attach_s3_policy_to_firehose_role" {
  count      = var.s3_logs_enabled ? 1 : 0
  role       = aws_iam_role.firehose_role[0].name
  policy_arn = aws_iam_policy.s3_firehose_policy[0].arn
}


resource "aws_kinesis_firehose_delivery_stream" "redis" {
  count       = var.firehose_logs_enabled && var.s3_logs_enabled ? 1 : 0
  name        = local.firehose_delivery_stream_name
  destination = "extended_s3"


  extended_s3_configuration {
    role_arn   = aws_iam_role.firehose_role[0].arn
    bucket_arn = data.aws_s3_bucket.engine_logs[0].arn
    prefix     = coalesce(var.s3_logs_prefix, local.s3_logs_prefix)
  }

  tags = {
    LogDeliveryEnabled = var.s3_logs_enabled
  }

  lifecycle {
    ignore_changes = [
      tags["LogDeliveryEnabled"],
    ]
  }
}
