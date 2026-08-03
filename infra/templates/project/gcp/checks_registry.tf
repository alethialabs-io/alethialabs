# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Artifact Registry provisioning + cross-project GAR pull invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

# Artifact Registry provisioning must be REAL. `provision_artifact_registry` was emitted from the
# mere PRESENCE of a registry row while `artifact_registry_repos` was emitted by NOTHING, so the
# module's for_each resolved to {} and a project with a native registry got zero repositories and an
# empty `artifact_registry_urls` map (#1835). This is the same guard aws/checks_registry.tf's
# `ecr_names_present_when_provisioned` puts on the identical defect, which ECR had first.
check "artifact_registry_repos_present_when_provisioned" {
  assert {
    condition     = !var.provision_artifact_registry || length(var.artifact_registry_repos) > 0
    error_message = "provision_artifact_registry is true but artifact_registry_repos is empty — no repository would be created; the tfvars emitter must supply one entry per native registry component."
  }
}

# The map KEY becomes part of the repository id (`<project>-<environment>-<key>`), which Google
# requires to be lowercase letters, numbers and hyphens. The canvas already restricts a registry name
# to exactly that; a snapshot arriving from the CLI or the API does not, and the emitter deliberately
# does NOT normalise the key because it is also the lookup key of the URL output. So it is checked
# rather than rewritten.
check "artifact_registry_repo_names_valid" {
  assert {
    condition = alltrue([
      for name, _ in var.artifact_registry_repos : can(regex("^[a-z0-9]+(-[a-z0-9]+)*$", name))
    ])
    error_message = "artifact_registry_repos contains an invalid repository name (must be lowercase alphanumerics with single - separators)."
  }
}

# Cross-project GAR pull (PR B): when gar-xacct is selected the cluster-side pull GSA must exist (the
# refresher's Workload-Identity impersonation target). A missing GSA means the refresher can't mint.
#
# Keyed on `gar_pull_requested` and naming `provision_gke` explicitly, exactly as
# checks_data.tf's keyless_cloud_sql_app_identity_wired does. Keying it on `enable_gar_pull` — which
# gained the cluster term — would make the check judge its own definition and go silent on precisely
# the shape it should report: gar-xacct selected with no cluster to run the refresher in.
check "gar_pull_xacct_identity_present" {
  assert {
    condition     = !local.gar_pull_requested || (var.provision_gke && length(google_service_account.gar_pull) == 1)
    error_message = "registry_pull_provider = gar-xacct but the cross-project GAR pull identity is incomplete: it needs provision_gke=true (the refresher runs in-cluster and impersonates the GSA via Workload Identity) and the pull service account."
  }
}
