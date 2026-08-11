# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Project B for the cross-PROJECT keyless Secret Manager e2e (#1268) — the GCP sibling of
# infra/aws-secrets-e2e.
#
# The e2e provisions a cluster in project A and proves a workload reads a secret that lives HERE, in
# project B, with no credential anywhere: ESO authenticates with the cluster's Workload Identity and
# reads project B directly. This stack is the customer's side of Model B, applied ONCE by hand.
#
# ── WHY THIS COULD NOT BE WRITTEN BEFORE, AND WHAT CHANGED ──────────────────────────────────────
#
# The AWS sibling trusts a narrow PRINCIPAL PATTERN (`ArnLike` on `aws:PrincipalArn`), which is what
# lets it survive a cluster that is destroyed and recreated every night. GCP has no equivalent: IAM
# bindings name an exact principal, and a deleted service account's binding is rewritten to
# `deleted:serviceAccount:...?uid=` — a same-named recreation does NOT inherit it.
#
# So the grant must name an identity that OUTLIVES the cluster. That is what
# `external_secrets_service_account_email` is for on the project template: when set, the template
# ADOPTS a standing GSA instead of creating a per-run one (workload-identity.tf reads it through a
# `data "google_service_account"`). Until an emitter existed, nothing could set it — which is why
# t2_secrets_xacct.go recorded the GCP lane as BLOCKED rather than pretending to cover the cloud.
#
# This stack grants that standing GSA read access to one canary secret. It does NOT create the GSA:
# that belongs in project A, next to the cluster, and is a separate maintainer step.
#
# ⚠️ The standing GSA is a long-lived identity with cross-project read on the secrets named below —
# by construction, since surviving the cluster is the whole point. Keep its grant to exactly the
# canary; checks.tf refuses a project-wide binding.

data "google_project" "current" {}

# The canary. One secret, one value, read across the project boundary and compared by sha256 — the
# value itself never leaves this stack, only its digest (see outputs.tf).
resource "google_secret_manager_secret" "canary" {
  project   = var.target_project_id
  secret_id = var.secret_name

  labels = var.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "canary" {
  secret      = google_secret_manager_secret.canary.id
  secret_data = var.canary_value
}

# The grant: the cluster's STANDING external-secrets GSA, on this ONE secret.
#
# `google_secret_manager_secret_iam_member` rather than `_binding`: a member is additive, so
# applying this cannot silently strip another grant the project already has. The `_binding` form is
# authoritative over the whole secret and would.
resource "google_secret_manager_secret_iam_member" "canary_reader" {
  project   = var.target_project_id
  secret_id = google_secret_manager_secret.canary.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.cluster_external_secrets_sa}"
}
