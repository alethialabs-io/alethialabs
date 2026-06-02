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
