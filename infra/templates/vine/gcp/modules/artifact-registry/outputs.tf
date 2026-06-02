output "repository_ids" {
  description = "Map of repository names to their Artifact Registry IDs"
  value = {
    for name, repo in google_artifact_registry_repository.repo :
    name => repo.id
  }
}

output "repository_urls" {
  description = "Map of repository names to their Docker registry URLs"
  value = {
    for name, repo in google_artifact_registry_repository.repo :
    name => "${var.region}-docker.pkg.dev/${var.project_id}/${repo.repository_id}"
  }
}
