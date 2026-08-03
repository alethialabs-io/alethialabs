################################################################################
# Private Repository
################################################################################
output "repository_names" {
  description = "List of ECR repository names"
  value       = [for m in values(module.ecr) : m.repository_name]
}
output "repository_urls_map" {
  description = "Map of repository URLs keyed by logical name"
  value       = { for k, m in module.ecr : k => m.repository_url }
}

# The lifecycle policy document actually handed to the upstream module. Exposed so
# checks_account_and_ecr.tftest.hcl can assert it against AWS's own >= 100-character
# constraint — the one that rejected an empty document mid-apply and that neither
# `tofu validate` nor a plan diff would have caught. It renders with no repositories
# configured, so the assertion costs nothing.
output "lifecycle_policy_document" {
  description = "The ECR lifecycle policy JSON passed to the upstream module (the template default unless overridden)."
  value       = local.lifecycle_policy
}