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
    # BOTH cache APIs, because the template moved and this list did not.
    #
    # `redis.googleapis.com` is the LEGACY Memorystore-for-Redis API. The gcp project template now
    # provisions `google_memorystore_instance`
    # (infra/templates/project/gcp/modules/memorystore-valkey), which is served by the NEW
    # `memorystore.googleapis.com` and by nothing else. With only the legacy API enabled, the cache
    # kind fails at apply with `Memorystore API has not been used in project … before or it is
    # disabled` — a message that names an API nobody enabled rather than the resource that wanted it.
    #
    # Caught by probing the project before spending a full bar on it, not by a run: the floor
    # provisions no cache, so nothing had ever asked for this API.
    #
    # The legacy entry stays. Removing it is a separate decision about brownfield projects that may
    # still hold a `google_redis_instance`, and this list is not the place to make it.
    "redis.googleapis.com",
    "memorystore.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "servicenetworking.googleapis.com",
    "pubsub.googleapis.com",
    "firestore.googleapis.com",
    "storage.googleapis.com",
    # Cost guard
    "billingbudgets.googleapis.com",
    # GKE application-layer Secrets encryption (#2092). Missing here is what made the first
    # post-promotion nightly fail at `google_kms_key_ring.gke_secrets` with a 403 SERVICE_DISABLED
    # (run 31356854945, #2262) — the code was correct and had simply never been applied for real.
    "cloudkms.googleapis.com",
  ])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
