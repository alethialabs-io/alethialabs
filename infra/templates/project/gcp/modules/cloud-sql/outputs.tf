output "connection_name" {
  description = "Cloud SQL instance connection name (project:region:instance)"
  value       = google_sql_database_instance.this.connection_name
}

output "instance_ip" {
  description = "Private IP address of the Cloud SQL instance"
  value       = google_sql_database_instance.this.private_ip_address
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
  value       = var.app_iam_sa_email != null ? google_sql_user.app_iam[0].name : null
}
