resource "google_artifact_registry_repository" "repo" {
  for_each = var.repos

  repository_id = "${var.project_name}-${var.environment}-${each.key}"
  location      = var.region
  project       = var.project_id
  # Hardcoded, and the root no longer pretends otherwise — see the note on artifact_registry_repos
  # in gcp/variables.tf. `docker_config` below is only valid for a DOCKER repository.
  format      = "DOCKER"
  description = each.value.description

  docker_config {
    # The canvas's "Immutable tags" switch. Google: "The repository which enabled this flag prevents
    # all tags from being modified, moved or deleted." Note it does NOT prevent tags from being
    # created — which is what the canvas label promises and no more.
    immutable_tags = each.value.immutable_tags
  }

  labels = merge(var.labels, {
    "repository" = each.key
  })
}
