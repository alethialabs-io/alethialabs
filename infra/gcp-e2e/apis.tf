# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Enable the APIs the e2e nightly needs — the WIF/STS plane to federate, and the estate services the
# provisioner stands up (GKE + Compute/VPC + Cloud SQL/Redis/DNS/Artifact Registry/Secret Manager/…)
# — so the least-privileged provisioner (no serviceUsageAdmin) never has to turn an API on mid-apply.
# Plus billingbudgets for the cost guard. disable_on_destroy=false so tearing the stack down never
# disables an API a concurrent run relies on.
resource "google_project_service" "apis" {
  for_each = toset([
    # Federation plane
    "iam.googleapis.com",
    "sts.googleapis.com",
    "iamcredentials.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    # Estate the project template provisions
    "compute.googleapis.com",
    "container.googleapis.com",
    "dns.googleapis.com",
    "sqladmin.googleapis.com",
    "redis.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "servicenetworking.googleapis.com",
    "pubsub.googleapis.com",
    "firestore.googleapis.com",
    "storage.googleapis.com",
    # Cost guard
    "billingbudgets.googleapis.com",
  ])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
