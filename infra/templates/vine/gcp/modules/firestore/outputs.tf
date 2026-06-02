output "database_name" {
  description = "The resource name of the Firestore database"
  value       = google_firestore_database.this.name
}

output "database_id" {
  description = "The ID of the Firestore database"
  value       = google_firestore_database.this.id
}
