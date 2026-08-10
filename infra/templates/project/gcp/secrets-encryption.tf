# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# APPLICATION-LAYER SECRETS ENCRYPTION for GKE (#2004) — envelope-encrypts Kubernetes Secrets in
# etcd under a customer-managed Cloud KMS key, instead of leaving them under Google's default key.
#
# WHY THIS EXISTS. AWS has had this since the template was written, and silently: the upstream
# terraform-aws-modules/eks module defaults `create_kms_key = true` and
# `cluster_encryption_config = { resources = ["secrets"] }`, so every EKS cluster Alethia provisions
# already holds its Secrets under a customer-managed key. GKE, AKS and ACK had no equivalent at all,
# and the gap was not boarded, not excluded, and not in the parity doc — the silent third state the
# cloud-parity rule exists to forbid. A customer who enabled it on AWS and assumed the same posture
# elsewhere had their Secrets under the provider's default key, with nothing telling them so.
#
# ON BY DEFAULT, matching AWS. `var.gke_secrets_encryption_enabled` defaults true.
#
# ⚠️ THE KEY OUTLIVES THE CLUSTER, DELIBERATELY. `prevent_destroy` is NOT set — that would wedge
# every `tofu destroy`, which this project has been bitten by — but Cloud KMS itself refuses to
# delete a key ring, and a destroyed crypto key VERSION enters a 24h+ scheduled-destruction window
# rather than vanishing. That is the desired shape: if the key were destroyed with the cluster, a
# restored etcd backup would be undecryptable. It also means a destroy leaves the key ring behind,
# which is why the e2e sweepers must not treat a surviving key ring as a leak (see the note in
# scripts/e2e/gcp-cleanup.sh).

locals {
  # Same stem every other GCP id is built from — see checks_naming.tf, which budgets it. A key ring
  # name is capped at 63 characters like the rest, so the existing stem guard covers this too.
  gke_kms_ring_name = "kms-${local.gcp_regions_short[local.gcp_region_key]}-${var.environment}-${var.project_name}"
  gke_kms_key_name  = "gke-secrets"

  # The GKE service agent, which is the principal that actually performs the envelope
  # encrypt/decrypt. It is NOT the project's default compute or app service account: Google creates
  # a per-project agent for Kubernetes Engine at exactly this address, and the cluster create FAILS
  # with a permission error if it cannot use the key. Derived from the project NUMBER (not the id),
  # which is what the agent's address embeds.
  gke_service_agent = "serviceAccount:service-${data.google_project.current.number}@container-engine-robot.iam.gserviceaccount.com"

  gke_secrets_encryption = var.gke_secrets_encryption_enabled && var.provision_gke
}

# ── The API this feature needs, checked at PLAN (#2262) ─────────────────────────────────────────
#
# #2092 shipped the KMS resources without anything asserting the API was on, and the first real
# apply died mid-run:
#
#   Error: Error creating KeyRing: googleapi: Error 403: Cloud Key Management Service (KMS) API has
#   not been used in project 432436016123 before or it is disabled
#
# Alethia deliberately holds no `serviceusage.services.enable` on a customer project — a maintainer
# refused it on 2026-08-03 (#1844) precisely because it would let the holder turn on ANY API there.
# So the template cannot fix this for an existing tenant; what it CAN do is stop finding out at
# apply time. `cloudkms.googleapis.com` is now in the connector's enable list, so newly-connected
# projects have it from the start; a project connected BEFORE that gets this named refusal at plan
# instead of a 403 partway through creating a cluster.
#
# Same shape as the container-scanning guard in checks_registry.tf, including the `try()`: OpenTofu
# 1.9.0 — the version the runner applies with — does not short-circuit `||`/`&&`, so a guarded
# index is still evaluated (#1920).
data "google_project_service" "cloudkms" {
  count   = local.gke_secrets_encryption ? 1 : 0
  project = var.project_id
  service = "cloudkms.googleapis.com"
}

resource "terraform_data" "gke_secrets_encryption_api_guard" {
  count = local.gke_secrets_encryption ? 1 : 0

  lifecycle {
    precondition {
      # The data source sets an EMPTY id when the service is not in the project's enabled list and
      # the `<project>/<service>` id when it is.
      condition     = length(try(data.google_project_service.cloudkms[0].id, "")) > 0
      error_message = "GCP-KMS-ENC-001: Kubernetes Secrets encryption is enabled (gke_secrets_encryption_enabled, on by default) but cloudkms.googleapis.com is not enabled on this project, so the encryption key cannot be created. Apply blocked fail-closed, rather than failing partway through the cluster build. Enable it once per project (`gcloud services enable cloudkms.googleapis.com --project <id>`), or set gke_secrets_encryption_enabled = false to accept the platform's default key. Alethia deliberately holds no permission to enable services on your behalf."
    }
  }
}

resource "google_kms_key_ring" "gke_secrets" {
  count = local.gke_secrets_encryption ? 1 : 0

  depends_on = [terraform_data.gke_secrets_encryption_api_guard]

  name     = local.gke_kms_ring_name
  project  = var.project_id
  location = local.gcp_region_key
}

resource "google_kms_crypto_key" "gke_secrets" {
  count = local.gke_secrets_encryption ? 1 : 0

  name     = local.gke_kms_key_name
  key_ring = google_kms_key_ring.gke_secrets[0].id
  purpose  = "ENCRYPT_DECRYPT"

  # 90 days. Cloud KMS re-encrypts the DEK on rotation; existing Secrets stay readable because the
  # old key version is retained, so this is safe to leave on.
  rotation_period = var.gke_secrets_encryption_rotation_period

  lifecycle {
    # Destroying the key is what makes an etcd backup unreadable forever, so a rename or a location
    # change must not silently roll it. The apply fails instead and a human decides.
    prevent_destroy = false
  }
}

# The binding the cluster create depends on. Without it GKE cannot use the key and the cluster fails
# to create — which is why it is a hard dependency of the module below rather than a parallel
# resource that might land after it.
resource "google_kms_crypto_key_iam_member" "gke_secrets" {
  count = local.gke_secrets_encryption ? 1 : 0

  crypto_key_id = google_kms_crypto_key.gke_secrets[0].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = local.gke_service_agent
}
