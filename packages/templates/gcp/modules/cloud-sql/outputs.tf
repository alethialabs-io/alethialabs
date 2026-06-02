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
