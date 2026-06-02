################################################################################
# AWS DynamoDB KMS key creation
################################################################################

module "dynamodb_kms" {
  for_each = { for table in var.table_configuration : table.table_name_suffix => table if table.custom_kms_key_create }
  source   = "./modules/kms-dynamodb/" # pipeline-trigger 123

  kms_key_alias              = "alias/ddb-${each.value.table_type == "regional" ? local.aws_regions_short[var.region] : "global"}-${var.environment}-${each.value.table_name_suffix}"
  kms_trusted_principal_arns = each.value.trusted_principal_arns
}
