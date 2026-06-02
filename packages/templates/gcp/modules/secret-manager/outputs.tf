output "secret_ids" {
  description = "Map of secret names to their Secret Manager resource IDs"
  value = {
    for name, secret in google_secret_manager_secret.secret :
    name => secret.id
  }
}

output "secret_names" {
  description = "Map of secret names to their full Secret Manager secret IDs"
  value = {
    for name, secret in google_secret_manager_secret.secret :
    name => secret.secret_id
  }
}
