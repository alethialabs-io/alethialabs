resource "google_artifact_registry_repository" "repo" {
  for_each = var.repos

  repository_id = "${var.project_name}-${var.environment}-${each.key}"
  location      = var.region
  project       = var.project_id
  format        = "DOCKER"
  description   = each.value.description

  docker_config {
    immutable_tags = each.value.immutable_tags
  }

  labels = merge(var.labels, {
    "repository" = each.key
  })
}
