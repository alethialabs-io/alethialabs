################################################################################
# DynmoDB KMS key
################################################################################

resource "aws_kms_key" "kms_dynamodb" {
  description         = "DynamoDB encryption"
  enable_key_rotation = true
  policy              = data.aws_iam_policy_document.kms_dynamodb.json
}

resource "aws_kms_alias" "kms_dynamodb" {
  name          = var.kms_key_alias
  target_key_id = aws_kms_key.kms_dynamodb.key_id
}

data "aws_iam_policy_document" "kms_dynamodb" {
  # https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-default.html#key-policy-default-allow-root-enable-iam
  statement {
    sid = "IAMUserPermissions"
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
    effect    = "Allow"
  }
  # https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/encryption.usagenotes.html
  statement {
    sid = "IAMRolePermissions"
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
      "kms:CreateGrant"
    ]
    condition {
      test     = "StringLike"
      variable = "kms:ViaService"
      values   = ["dynamodb.*.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "kms:CallerAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    resources = ["*"]
    effect    = "Allow"
  }
  statement {
    sid = "DynamoDB"
    principals {
      type        = "Service"
      identifiers = ["dynamodb.amazonaws.com"]
    }
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
      "kms:CreateGrant"
    ]
    resources = ["*"]
    effect    = "Allow"
  }
  # allow cross account access
  dynamic "statement" {
    # only create statement if length is non-zero
    for_each = try(length(var.kms_trusted_principal_arns), 0) == 0 ? toset([]) : toset([0])
    content {
      sid = "CrossAccountDynamoDB"
      principals {
        type        = "AWS"
        identifiers = var.kms_trusted_principal_arns
      }
      actions = [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:DescribeKey",
        "kms:CreateGrant"
      ]
      condition {
        test     = "StringLike"
        variable = "kms:ViaService"
        values   = ["dynamodb.*.amazonaws.com"]
      }
      resources = ["*"]
      effect    = "Allow"
    }
  }
}
