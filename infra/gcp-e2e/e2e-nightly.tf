# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# BYOC A2.1 — the e2e-nightly GCP WIF federation: the identity the T2 real-cloud nightly
# (.github/workflows/e2e-nightly.yml, provider=gcp) assumes to provision + tear down a genuine,
# ephemeral GKE cluster from infra/templates/project/gcp (GKE + VPC + Cloud SQL + … ).
#
# Mirrors infra/aws-oidc/e2e-nightly.tf, translated to Google's Workload Identity Federation:
#
#   1. A ref-bound WIF trust — the Workload Identity Pool PROVIDER carries an attribute CONDITION
#      that admits ONLY GitHub tokens whose `repository` is EXACTLY var.github_repo AND whose `ref`
#      is EXACTLY var.e2e_github_ref (CEL `==`, exact match — never a prefix/glob). PRs, forks, and
#      sibling branches mint a token the provider rejects at the exchange, so they can never federate.
#   2. Least-privilege-ish estate roles — the SA is granted the SAME enumerated predefined roles the
#      customer connector uses (infra/connector/gcp/main.tf), led by roles/container.admin. GKE
#      self-admin works through container.admin — no template RBAC change is needed (contrast the AWS
#      EKS access-entry gap). A provisioning identity is inherently broad; the wall is the ref-bound
#      trust + the DEDICATED e2e project (var.project_id) + the budget, NOT a narrow action list.
#   3. A monthly Budget + Pub/Sub cost kill-signal (see e2e-budget.tf).
#
# Applied by the maintainer with an admin identity into a THROWAWAY e2e project. Agents never apply.

locals {
  # The full canonical GitHub OIDC subject this run federates as, for documentation/outputs.
  # (The provider's attribute condition — not the subject — is what enforces the repo+ref binding.)
  e2e_subject = "repo:${var.github_repo}:ref:${var.e2e_github_ref}"

  # The provider's attribute CONDITION (CEL): admit ONLY this repo AND this ref, both exact. This is
  # the StringEquals-equivalent gate — no wildcard, no prefix. Both clauses are required (an && of two
  # exact equalities) so a token from the right repo but the wrong branch (e.g. a PR) is rejected.
  e2e_attr_condition = "attribute.repository == \"${var.github_repo}\" && attribute.ref == \"${var.e2e_github_ref}\""

  # The WIF principalSet the SA binding trusts: any identity from THIS repo that already passed the
  # provider's attribute condition (which pins the ref). Scoped to attribute.repository == our repo.
  e2e_principal = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.e2e.name}/attribute.repository/${var.github_repo}"

  # The estate roles the provisioner needs — cribbed verbatim from the customer connector
  # (infra/connector/gcp/main.tf), led by container.admin (GKE self-admin). Kept in parity so the
  # e2e nightly proves exactly what a real customer connection grants.
  e2e_provisioner_roles = [
    "roles/container.admin",                 # GKE clusters + node pools (self-admin at create time)
    "roles/compute.networkAdmin",            # VPC, subnets, router, NAT, global addresses
    "roles/compute.securityAdmin",           # firewall rules, Cloud Armor, SSL certs
    "roles/servicenetworking.networksAdmin", # private-services peering (Cloud SQL / Memorystore)
    "roles/cloudsql.admin",                  # Cloud SQL
    "roles/redis.admin",                     # Memorystore
    "roles/dns.admin",                       # Cloud DNS managed zones
    "roles/artifactregistry.admin",          # Artifact Registry
    "roles/secretmanager.admin",             # Secret Manager
    "roles/storage.admin",                   # GCS buckets + bucket IAM
    "roles/datastore.owner",                 # Firestore (uses Datastore IAM)
    "roles/pubsub.admin",                    # Pub/Sub
    "roles/iam.serviceAccountAdmin",         # create the add-on GSAs (e.g. external-dns)
    "roles/iam.serviceAccountUser",          # actAs the node/add-on SAs
    "roles/browser",                         # data.google_project / client-config reads
  ]
}

# ── The e2e provisioner service account (federated into via WIF; never gets a key) ──
resource "google_service_account" "e2e" {
  account_id   = var.service_account_id
  display_name = "Alethia e2e nightly provisioner"
  description  = "Federated (WIF) by the T2 real-cloud nightly to provision + tear down an ephemeral GKE cluster. Ref-bound trust + dedicated project + budget capped. See infra/gcp-e2e/e2e-nightly.tf."

  depends_on = [google_project_service.apis]
}

# ── Estate roles on the DEDICATED e2e project (never a shared/prod project). ──
resource "google_project_iam_member" "e2e_provisioner" {
  for_each = toset(local.e2e_provisioner_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.e2e.email}"
}

# ── The Workload Identity Pool + GitHub OIDC provider (ref-bound). ──
resource "google_iam_workload_identity_pool" "e2e" {
  workload_identity_pool_id = var.pool_id
  display_name              = "Alethia e2e GitHub pool"
  description               = "Trusts GitHub Actions OIDC for the ref-bound e2e nightly federation."

  depends_on = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "e2e" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.e2e.workload_identity_pool_id
  workload_identity_pool_provider_id = var.provider_id
  display_name                       = "GitHub OIDC (ref-bound)"

  # Map the claims the trust + bindings key off. google.subject is the token subject; the two
  # attributes are what the CONDITION below (and the SA principalSet) pin.
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # The ref-bound gate: only tokens from EXACTLY this repo AND this ref pass the exchange.
  attribute_condition = local.e2e_attr_condition

  oidc {
    issuer_uri        = var.github_oidc_issuer
    allowed_audiences = [] # google-github-actions/auth mints the WIF-provider audience by default.
  }
}

# ── Bind the WIF principal (repo-scoped, ref-pinned by the provider condition) to impersonate the
#    provisioner SA. This is the analogue of the AWS role's OIDC trust statement. ──
resource "google_service_account_iam_member" "e2e_wif" {
  service_account_id = google_service_account.e2e.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.e2e_principal
}
