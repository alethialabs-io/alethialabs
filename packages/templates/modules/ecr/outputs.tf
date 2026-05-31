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