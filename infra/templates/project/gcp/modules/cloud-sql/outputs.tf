output "connection_name" {
  description = "Cloud SQL instance connection name (project:region:instance)"
  value       = google_sql_database_instance.this.connection_name
}

output "instance_ip" {
  description = "Private IP address of the Cloud SQL instance"
  value       = google_sql_database_instance.this.private_ip_address
}

# The instance's server CA and its mode, which the database bootstrap Jobs verify the server against
# (#6521): they connect by private IP with VERIFY_CA / verify-ca, which identifies the instance only
# while it has its own CA (GOOGLE_MANAGED_INTERNAL_CA, the default for instances Terraform creates), so
# the Jobs refuse any other mode. Public certificates, not secrets.
output "server_ca_cert" {
  description = "PEM of the instance's current server CA certificate — the trust anchor the database bootstrap Jobs verify the server against (#6521)"
  value       = try(google_sql_database_instance.this.server_ca_cert[0].cert, null)
}

output "server_ca_mode" {
  description = "The instance's server CA mode (settings.ip_configuration.server_ca_mode); the bootstrap Jobs verify by CA alone only for GOOGLE_MANAGED_INTERNAL_CA (#6521)"
  value       = try(google_sql_database_instance.this.settings[0].ip_configuration[0].server_ca_mode, null)
}

output "database_name" {
  description = "Name of the default database"
  value       = google_sql_database.default.name
}

output "credentials_secret_id" {
  description = "Secret Manager secret ID containing database credentials"
  value       = google_secret_manager_secret.db_credentials.secret_id
}

output "instance_name" {
  description = "Cloud SQL instance name (for keyless app-user / IAM grants, #722)"
  value       = google_sql_database_instance.this.name
}

# This must be WHAT THE APP ACTUALLY LOGS IN AS — the bootstrap GRANT target and the proxy login both
# key off it — and the form is engine-specific (#1505): "sa@project.iam" on PostgreSQL, the
# lowercased SA local part on MySQL (Cloud SQL truncates the @ and the domain).
output "app_iam_user" {
  description = "Keyless app database username — the CLOUD_IAM_SERVICE_ACCOUNT login as the engine stores it (#722, #1505); null when no app GSA was passed"
  value       = var.app_iam_sa_email != null ? one(google_sql_user.app_iam[*].name) : null
}

# Read off the PLANNED instance, not the input, so checks_customize.tftest.hcl fails if the
# insights_config block ever stops reading the variable (#5532). An empty list means no block, which
# happens only when query_insights_enabled is unset (null); false plans one block switched off.
output "insights_config" {
  description = "The instance's planned settings.insights_config blocks: empty only when query_insights_enabled is unset (null); false plans one block with query_insights_enabled = false"
  value       = google_sql_database_instance.this.settings[0].insights_config
}
