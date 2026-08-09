terraform {
  required_providers {
    google = {
      source = "hashicorp/google"
      # >= 6.15.0 for `vulnerability_scanning_config` on google_artifact_registry_repository. The
      # root lockfile already resolves 6.50.0, so this names the floor rather than moving anything.
      version = ">= 6.15.0"
    }
  }
}

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

  # The canvas's "Vulnerability scanning" switch. The enum is INHERITED | DISABLED — Google offers
  # no per-repository ENABLED — so ON means "follow the project default", which is on only when
  # `containerscanning.googleapis.com` is enabled on the project. The root REFUSES the ON position
  # when it is not (checks_registry.tf), so INHERITED here always lands on a project that scans.
  vulnerability_scanning_config {
    enablement_config = each.value.vulnerability_scanning ? "INHERITED" : "DISABLED"
  }

  labels = merge(var.labels, {
    "repository" = each.key
  })
}
