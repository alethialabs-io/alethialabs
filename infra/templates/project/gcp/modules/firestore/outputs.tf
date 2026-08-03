output "database_name" {
  description = "The resource name of the Firestore database"
  value       = google_firestore_database.this.name
}

output "database_id" {
  description = "The ID of the Firestore database"
  value       = google_firestore_database.this.id
}

# Read off the RESOURCE, never off `var.point_in_time_recovery` — that distinction is the entire
# value of this output. It exists so `checks_firestore_pitr.tftest.hcl` can assert what the PLAN
# says the database will be, from the root, where `tofu test` can actually see it. Echoing the input
# back would assert only that a variable equals itself, and would keep passing after someone deleted
# the argument from the resource.
output "point_in_time_recovery_enablement" {
  description = "The point-in-time recovery enablement the plan will apply to the database"
  value       = google_firestore_database.this.point_in_time_recovery_enablement
}
