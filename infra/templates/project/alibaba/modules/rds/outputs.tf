# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "instance_id" {
  description = "Id of the RDS instance"
  value       = alicloud_db_instance.this.id
}

output "connection_string" {
  description = "Private connection string of the RDS instance"
  value       = alicloud_db_instance.this.connection_string
}

output "port" {
  description = "Port of the RDS instance"
  value       = alicloud_db_instance.this.port
}

output "database_name" {
  description = "Name of the default database"
  value       = alicloud_db_database.this.data_base_name
}

output "account_name" {
  description = "Name of the default database account"
  value       = alicloud_rds_account.this.account_name
}

output "account_password" {
  description = "Generated password for the default database account"
  value       = random_password.account.result
  sensitive   = true
}
