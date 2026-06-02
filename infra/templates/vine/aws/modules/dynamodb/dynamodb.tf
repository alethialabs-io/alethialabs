################################################################################
# AWS DynamoDB table creation
################################################################################

module "dynamodb_table" {
  for_each = { for table in var.table_configuration : table.table_name_suffix => table }
  source   = "cloudposse/dynamodb/aws"
  version  = "~> 0.34.0"

  name                               = "ddb-${each.value.table_type == "regional" ? local.aws_regions_short[var.region] : "global"}-${var.environment}-${each.value.table_name_suffix}"
  hash_key                           = each.value.hash_key
  range_key                          = each.value.range_key
  hash_key_type                      = each.value.hash_key_type
  range_key_type                     = each.value.range_key_type
  enable_autoscaler                  = each.value.enable_autoscaler
  dynamodb_attributes                = each.value.dynamodb_attributes
  global_secondary_index_map         = each.value.global_secondary_index_map
  local_secondary_index_map          = each.value.local_secondary_index_map
  replicas                           = each.value.replicas
  tags_enabled                       = each.value.tags_enabled
  billing_mode                       = each.value.billing_mode
  ttl_enabled                        = each.value.ttl_enabled
  ttl_attribute                      = each.value.ttl_attribute
  enable_point_in_time_recovery      = each.value.enable_point_in_time_recovery
  stream_view_type                   = each.value.table_type == "global" ? "NEW_AND_OLD_IMAGES" : ""
  deletion_protection_enabled        = each.value.deletion_protection_enabled
  server_side_encryption_kms_key_arn = each.value.custom_kms_key_create && each.value.custom_kms_key_use ? module.dynamodb_kms[each.key].kms_key_arn : null
}

resource "null_resource" "replica_deletion_protection" {
  for_each = { for table in var.table_configuration : table.table_name_suffix => table if table.table_type == "global" }

  triggers = {
    deletion_protection_enabled = each.value.deletion_protection_enabled
    replicas                    = join(",", each.value.replicas)
  }



  depends_on = [module.dynamodb_table]
}

resource "aws_dynamodb_resource_policy" "dynamodb_table" {
  for_each = { for table in var.table_configuration : table.table_name_suffix => table if table.trusted_principal_arns != null }

  resource_arn = module.dynamodb_table[each.key].table_arn
  policy       = data.aws_iam_policy_document.dynamodb_table[each.key].json
}

data "aws_iam_policy_document" "dynamodb_table" {
  for_each = { for table in var.table_configuration : table.table_name_suffix => table if table.trusted_principal_arns != null }

  # https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/rbac-examples.html#rbac-examples-iam
  statement {
    sid = "CrossAccountPermissions"
    principals {
      type        = "AWS"
      identifiers = each.value.trusted_principal_arns
    }
    # https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/rbac-iam-actions.html
    actions = [
      # Data plane API
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:UpdateItem",
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      # Control plane API
      "dynamodb:DescribeTable",
    ]
    resources = [
      module.dynamodb_table[each.key].table_arn,
      "${module.dynamodb_table[each.key].table_arn}/*"
    ]
    effect = "Allow"
  }
}
