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

# Same reasoning as repository_immutable_tags, one boundary further: `vulnerability_scanning` is a
# BOOL on both object types and an ENUM on the resource, so the mapping (true → INHERITED, false →
# DISABLED) is a place the switch can be carried and still mean nothing. Projected off the resource
# so a root test asserts what was planned, not what was passed in.
output "repository_vulnerability_scanning" {
  description = "Map of repository names to the enablement_config planned on the resource"
  value = {
    for name, repo in google_artifact_registry_repository.repo :
    name => repo.vulnerability_scanning_config[0].enablement_config
  }
}

output "repository_urls" {
  description = "Map of repository names to their Docker registry URLs"
  value = {
    for name, repo in google_artifact_registry_repository.repo :
    name => "${var.region}-docker.pkg.dev/${var.project_id}/${repo.repository_id}"
  }
}
