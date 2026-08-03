output "repository_ids" {
  description = "Map of repository names to their Artifact Registry IDs"
  value = {
    for name, repo in google_artifact_registry_repository.repo :
    name => repo.id
  }
}

# Read back off the RESOURCE, not off `var.repos`, and that is the whole point: it is the only thing
# a root-level `.tftest.hcl` can address to prove that the canvas's "Immutable tags" switch reached
# `docker_config.immutable_tags` rather than being dropped at the module boundary — which is exactly
# what happened to `format`, and to cloud-storage's `uniform_access`. Echoing the variable back would
# assert nothing the variable's own default does not already guarantee.
output "repository_immutable_tags" {
  description = "Map of repository names to the immutable_tags setting planned on the resource"
  value = {
    for name, repo in google_artifact_registry_repository.repo :
    name => repo.docker_config[0].immutable_tags
  }
}

output "repository_urls" {
  description = "Map of repository names to their Docker registry URLs"
  value = {
    for name, repo in google_artifact_registry_repository.repo :
    name => "${var.region}-docker.pkg.dev/${var.project_id}/${repo.repository_id}"
  }
}
