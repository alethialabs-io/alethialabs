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

# ── Vulnerability scanning: the ON position needs a project-level API the provisioner cannot
#    enable, so the template REFUSES it rather than landing on a no-op (#1844). ──
#
# `google_artifact_registry_repository.vulnerability_scanning_config.enablement_config` is
# `INHERITED | DISABLED`. There is no `ENABLED`. OFF maps exactly onto DISABLED; ON can only mean
# "follow the project default", and that default is on only when `containerscanning.googleapis.com`
# is enabled on the tenant's project.
#
# Enabling it needs `serviceusage.services.enable`, which lets the holder turn on ANY API in the
# customer's project — including billable ones nobody asked for — and there is no narrower version
# of that verb. The maintainer refused it (2026-08-03), and refused the fleet-wide connector re-run
# that would have made a late grant retroactive, on the grounds that a PARTIAL rollout is worse than
# none: a tenant that did not re-run plans clean, greens the carrier probe, and scans nothing.
#
# So the API is an onboarding prerequisite the customer performs, and this refuses the switch when
# it has not been. The connector grants only the READ verb (`serviceusage.services.get`, on the
# alethiaProjectReader custom role) — enough to see the answer, not to change it.
#
# A `terraform_data` precondition, NOT a `check`: a check never blocks an apply, it only warns, and a
# warning here reproduces exactly the failure this is meant to prevent — switch ON, nothing scanned,
# run green.
locals {
  # Named as a local so the data source and the guard cannot disagree about when to run.
  artifact_registry_scanning_requested = anytrue([
    for _, repo in var.artifact_registry_repos : coalesce(repo.vulnerability_scanning, false)
  ])
}

# count, so a project with the switch OFF — which is every project that has not asked for scanning —
# never reads this and never needs the permission. The read is scoped to the one tenant that turned
# the switch on.
data "google_project_service" "container_scanning" {
  count   = local.artifact_registry_scanning_requested ? 1 : 0
  project = var.project_id
  service = "containerscanning.googleapis.com"
}

resource "terraform_data" "artifact_registry_scanning_guard" {
  count = local.artifact_registry_scanning_requested ? 1 : 0

  lifecycle {
    precondition {
      # The data source sets an EMPTY id when the service is not in the project's enabled list
      # (resource_google_project_service.go: `d.SetId("")` on the not-found branch) and the
      # `<project>/<service>` id when it is. `try()` because OpenTofu 1.9.0 — the version the runner
      # ships — does not short-circuit `||`/`&&`, so a guarded index is still evaluated (#1920).
      condition     = length(try(data.google_project_service.container_scanning[0].id, "")) > 0
      error_message = "GCP-AR-SCAN-001: a container registry asks for vulnerability scanning, but containerscanning.googleapis.com is not enabled on this project. Artifact Registry has no per-repository ENABLE — the switch can only follow the project default — so turning it on here would scan nothing. Apply blocked fail-closed. Enable the API once per project (`gcloud services enable containerscanning.googleapis.com --project <id>`); Alethia deliberately holds no permission to enable services on your behalf."
    }
  }
}
