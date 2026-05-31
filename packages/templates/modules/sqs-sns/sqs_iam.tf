locals {
  sqs_arns = [ for idx, value in var.sqs_queues : aws_sqs_queue.sqs_queue[idx].arn ]
  sns_arns = [ for idx, value in var.sns_topics : aws_sns_topic.sns_topic[idx].arn ]
  iam_arns = concat(local.sqs_arns, local.sns_arns)
}

resource "aws_iam_user" "sqs" {
  count = var.sqs_username == "" ? 0 : 1
  name = var.sqs_username

  tags = var.global_tags
}

resource "aws_iam_access_key" "sqs" {
  count = var.sqs_username == "" ? 0 : 1
  user = aws_iam_user.sqs[0].name
}

resource "aws_iam_user_policy" "sns_granular_access" {
  count = var.sqs_username == "" ? 0 : 1
  name = "SQS-Granular-Access"
  user = aws_iam_user.sqs[0].name

  policy = data.aws_iam_policy_document.sqsmq.json
}

data "aws_iam_policy_document" "sqsmq" {
  statement {
    sid = "1"

    actions = [
      "sns:*",
      "sqs:*",
    ]

    resources = local.iam_arns
  }
}

data "aws_iam_policy_document" "assume" {
  statement {
    sid = "2"

    actions = [
      "sts:AssumeRole",
      "sts:AssumeRoleWithWebIdentity",
    ]
    principals {
      type        = "Federated"
      identifiers = ["arn:aws:iam::*:oidc-provider/oidc.eks.*.amazonaws.com/*"]
    }
  }
}

resource "aws_iam_role" "sqsmq" {
  count              = var.sqs_iam_role_name == "" ? 0 : 1
  name               = var.sqs_iam_role_name
  assume_role_policy = data.aws_iam_policy_document.assume.json

  tags = var.global_tags
}

resource "aws_iam_role_policy" "sqsmq" {
  count  = var.sqs_iam_role_name == "" ? 0 : 1
  name   = "${var.sqs_iam_role_name}-policy"
  role   = aws_iam_role.sqsmq[0].id
  policy = data.aws_iam_policy_document.sqsmq.json
}
