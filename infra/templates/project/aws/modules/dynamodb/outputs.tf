output "table_name" {
  value = {
    for table in var.table_configuration : table.table_name_suffix => module.dynamodb_table[table.table_name_suffix].table_name
  }
  description = "DynamoDB table name"
}

output "table_id" {
  value = {
    for table in var.table_configuration : table.table_name_suffix => module.dynamodb_table[table.table_name_suffix].table_id
  }
  description = "DynamoDB table ID"
}

output "table_arn" {
  value = {
    for table in var.table_configuration : table.table_name_suffix => module.dynamodb_table[table.table_name_suffix].table_arn
  }
  description = "DynamoDB table ARN"
}

# The exact expression dynamodb.tf line 26 hands the table, surfaced so the root can be tested. A
# table that plans with deletion protection ON cannot be deleted, which fails `tofu destroy` on the
# table and strands everything downstream of it (RDS/ElastiCache ENIs, then the subnets and VPC).
# `modules/**/*.tftest.hcl` is silently never executed by `tofu test`, so the assertion has to live
# at the root — and it can only reach this through an output.
output "table_deletion_protection" {
  value = {
    for table in var.table_configuration : table.table_name_suffix => table.deletion_protection_enabled
  }
  description = "Per-table deletion_protection_enabled as materialised for the table resource."
}
