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

  # The full subject a DISPATCH federates as when it declares the branch-restricted GitHub
  # environment. GitHub replaces the `ref:` form with `environment:` in `sub` for such a job, so this
  # is a DIFFERENT exact string, not a relaxation of the one above.
  e2e_env_subject = var.e2e_github_environment != "" ? "repo:${var.github_repo}:environment:${var.e2e_github_environment}" : ""

  # The provider's attribute CONDITION (CEL): admit ONLY this repo, AND then only an exact ref or an
  # exact environment subject. Still the StringEquals-equivalent gate — no wildcard, no prefix.
  #
  # WHY THE SUBJECT AND NOT JUST A SECOND REF. Adding `refs/heads/dev` to the ref clause would trust
  # EVERY workflow running on dev. Keying the second disjunct on `assertion.sub` narrows it to a job
  # that declared the environment, and the environment's own deployment-branch policy (a single custom
  # policy, `dev`) is what pins the branch — GitHub-side, auditable, and changeable without an apply.
  # Empty `e2e_github_environment` ⇒ the disjunct is omitted entirely and this is byte-identical to the
  # ref-only condition, so the default posture is unchanged.
  e2e_attr_condition = var.e2e_github_environment != "" ? "attribute.repository == \"${var.github_repo}\" && (attribute.ref == \"${var.e2e_github_ref}\" || assertion.sub == \"${local.e2e_env_subject}\")" : "attribute.repository == \"${var.github_repo}\" && attribute.ref == \"${var.e2e_github_ref}\""

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
    "roles/cloudkms.admin",                  # CMK for GKE Secrets encryption (#2092, on by default)
  ]
}

# ── Service-enablement + project-metadata reads: the connector's alethiaProjectReader, mirrored ──
#
# This REPLACES roles/browser, and the swap is load-bearing rather than cosmetic. #2269 added a
# plan-time guard to the GCP template (GCP-KMS-ENC-001, infra/templates/project/gcp/secrets-encryption.tf)
# that reads service-enablement state:
#
#   data "google_project_service" "cloudkms" { ... }   →   serviceusage.services.get
#
# roles/browser is a pure resourcemanager role (projects.get/list/getIamPolicy, folders.get/list,
# organizations.get) and carries NO serviceusage permission. So with browser alone this leg fails at
# PLAN, on the guard, with a serviceusage error that names nothing about KMS — a worse red than the
# apply-time 403 it was added to prevent.
#
# The customer connector already solved exactly this and moved off browser for the same reason
# (infra/connector/gcp/main.tf, google_project_iam_custom_role.project_reader, #1844). Mirroring it
# here keeps the parity this file's header promises: the nightly proves what a real connection grants,
# and it drops browser's folder/org hierarchy reads, which nothing in the templates ever needed.
#
# `serviceusage.services.enable` stays refused (maintainer, 2026-08-03, #1844): `get` reads a boolean
# about a service the project owner already chose, `enable` would let the holder turn on any billable
# API. apis.tf enables cloudkms.googleapis.com on this dedicated e2e project, so `get` is sufficient.
# The one DNS permission roles/dns.admin does not carry — mirroring the customer connector's
# alethiaDnsZoneIam, because the e2e SA provisions the same template and hits the same wall.
#
# The gcp template creates a zone-scoped binding for external-dns
# (infra/templates/project/gcp/workload-identity.tf), which needs `dns.managedZones.setIamPolicy`.
# Measured against the live API: roles/dns.admin has getIamPolicy but NOT setIamPolicy; neither does
# roles/editor or roles/dns.peer; only roles/owner does. gcp's first full bar (32840106190) failed at
#
#   Error setting IAM policy for dns managedzone "...": Error 403: The caller does not have
#   permission, forbidden
#
# after 48 minutes, because a floor run never provisions a DNS zone and so never reaches it.
resource "google_project_iam_custom_role" "e2e_dns_zone_iam" {
  role_id     = "alethiaE2eDnsZoneIam"
  project     = var.project_id
  title       = "Alethia e2e DNS Zone IAM Binder"
  description = "Set/get IAM policy on Cloud DNS managed zones — the zone-scoped external-dns binding. roles/dns.admin does NOT include setIamPolicy; only roles/owner does. Mirrors the customer connector's alethiaDnsZoneIam."
  permissions = [
    "dns.managedZones.getIamPolicy",
    "dns.managedZones.setIamPolicy",
  ]
}

resource "google_project_iam_custom_role" "e2e_project_reader" {
  role_id     = "alethiaE2eProjectReader"
  project     = var.project_id
  title       = "Alethia e2e Project Reader"
  description = "Read project metadata and service-enablement state (replaces roles/browser; no folder/org hierarchy reads). Mirrors the customer connector's alethiaProjectReader."
  permissions = [
    "resourcemanager.projects.get",
    "serviceusage.services.get",
  ]
}

# ⚠️ KEYED ON STATIC STRINGS, NOT ON THE ROLE IDS. `toset` uses its ELEMENTS as instance keys, and
# `google_project_iam_custom_role.e2e_dns_zone_iam.id` is `(known after apply)` for a role that does
# not exist yet — one unknown element makes the whole set unknown, and OpenTofu refuses at plan:
#
#     Invalid for_each argument … depends on resource attributes that cannot be determined until apply
#
# `tofu validate` never evaluates `for_each` and no CI job plans this stack, so the first thing that
# would have failed is the maintainer's apply — the apply this grant exists to unblock. A map keyed
# on literals is known at plan; only the VALUES are unknown, which for_each permits.
resource "google_project_iam_member" "e2e_provisioner_custom" {
  for_each = {
    project_reader = google_project_iam_custom_role.e2e_project_reader.id
    dns_zone_iam   = google_project_iam_custom_role.e2e_dns_zone_iam.id
  }
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.e2e.email}"
}

# The resource was un-keyed before this change and is already applied, so without this the plan is
# destroy-old + create-new with NO dependency edge between them. Both instances read-modify-write the
# same (project, role, member) triple; if the destroy lands after the create, the binding is REMOVED
# while state says it is present — the SA silently loses `serviceusage.services.get` and the next
# nightly dies at plan on the KMS guard, with an error naming nothing about IAM.
moved {
  from = google_project_iam_member.e2e_provisioner_custom
  to   = google_project_iam_member.e2e_provisioner_custom["project_reader"]
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
