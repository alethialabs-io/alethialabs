output "policy_id" {
  description = "The ID of the Cloud Armor security policy"
  value       = google_compute_security_policy.policy.id
}

output "policy_self_link" {
  description = "The self link of the Cloud Armor security policy"
  value       = google_compute_security_policy.policy.self_link
}
