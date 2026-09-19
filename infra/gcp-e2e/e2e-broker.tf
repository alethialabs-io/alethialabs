# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# #4226 — let the e2e provisioner service account accept a short-lived assertion minted by the
# dedicated E2E assertion broker (apps/e2e-issuer, contract in packages/workload-identity/src/
# broker.ts), in ADDITION to the GitHub Actions WIF trust in e2e-nightly.tf.
#
# OFF BY DEFAULT. `e2e_broker_issuer_url = null` (the committed value in terraform.tfvars) creates
# nothing, so a plan on this change alone is a no-op. Setting it creates a pool, a provider and ONE
# additive `google_service_account_iam_member`; setting it back to null destroys exactly those three.
#
# A SEPARATE POOL, not a second provider in the GitHub pool — and that is load-bearing. The GitHub
# binding (google_service_account_iam_member.e2e_wif) trusts
#   principalSet://…/workloadIdentityPools/<github pool>/attribute.repository/<repo>
# i.e. ANY identity in that pool whose mapped `repository` attribute is our repo. The broker's
# assertion carries a `repository` claim with exactly that value, so a broker provider in the same
# pool that mapped it would be admitted by the GitHub binding too, bypassing the subject pin below.
# A pool of its own keeps the two trusts disjoint, and removing one cannot touch the other.
#
# WHAT GCP PINS — the only cloud of the four whose trust can read the broker's custom claims:
#
#   issuer    — oidc.issuer_uri, exact
#   audience  — allowed_audiences = [`alethia-gcp-wif`], read from WORKLOAD_PROVIDER_AUDIENCES
#   subject   — the SA binding names ONE principal: …/subject/alethia-connector (WORKLOAD_SUBJECT)
#   run       — the attribute condition requires assertion.provider == "gcp", assertion.repository
#               == var.github_repo and assertion.workflow_ref ∈ var.e2e_broker_workflow_refs.
#               run_id / run_attempt change every run and cannot be pinned by a standing trust; the
#               broker binds them to the caller's GitHub token and consumes each token once.
#
# LIFETIME. WIF has no trust-side knob for the incoming token's lifetime; it refuses an expired one.
# The assertion lifetime is capped by the broker at 60–600s (MIN_/MAX_ASSERTION_TTL_SECONDS,
# enforced by brokerAssertionRequestSchema). The SA access token it buys is bounded by the lifetime
# the caller requests from generateAccessToken (default and maximum without an org-policy exception:
# one hour).
#
# DELETION IS SOFT. A destroyed pool is kept deleted-but-recoverable for 30 days and its ID cannot be
# reused in that window — re-enabling within 30 days needs `gcloud iam workload-identity-pools
# undelete` first. The runbook says so.
#
# Applied by the maintainer only; see docs/testing/e2e-federation-apply-runbook.md.

locals {
  # The ONE copy of the broker contract is TypeScript. Read it rather than restate it (#4236: a
  # hand-typed second copy of these audiences failed the nightly with no repo diff to explain it).
  # A moved file or a changed shape makes `regex` fail and the plan error before anything applies.
  broker_contract  = file("${path.module}/../../packages/workload-identity/src/broker.ts")
  broker_audiences = regex("WORKLOAD_PROVIDER_AUDIENCES[^=]*=\\s*\\{([^}]*)\\}", local.broker_contract)[0]
  broker_audience  = regex("\\bgcp:\\s*\"([^\"]+)\"", local.broker_audiences)[0]
  broker_subject   = regex("WORKLOAD_SUBJECT\\s*=\\s*\"([^\"]+)\"", local.broker_contract)[0]

  broker_enabled = var.e2e_broker_issuer_url != null

  # CEL, exact equality and list membership only — no prefix, no glob. `jsonencode` renders the refs
  # as a CEL list literal of double-quoted strings; the variable's validation keeps quotes, `*` and
  # whitespace out of them.
  broker_attr_condition = join(" && ", [
    "assertion.sub == \"${local.broker_subject}\"",
    "assertion.provider == \"gcp\"",
    "assertion.repository == \"${var.github_repo}\"",
    "assertion.workflow_ref in ${jsonencode(var.e2e_broker_workflow_refs)}",
  ])

  # The pool's resource name, BUILT from plan-time values rather than read off the resource. `name`
  # is computed, so a member that embedded google_iam_workload_identity_pool.e2e_broker[0].name
  # would plan as `(known after apply)` on the very plan that enables the broker, and the
  # e2e_broker_binding_is_one_subject check could not read it. GCP names a pool
  # `projects/<project NUMBER>/locations/global/workloadIdentityPools/<pool id>`; the number comes
  # from data.google_project.this, which is read at plan. The check `e2e_broker_pool_name_matches`
  # (checks.tf) compares this with the resource's real `name` once it is known.
  broker_pool_name = "projects/${data.google_project.this.number}/locations/global/workloadIdentityPools/${var.broker_pool_id}"
  broker_principal = "principal://iam.googleapis.com/${local.broker_pool_name}/subject/${local.broker_subject}"
}

resource "google_iam_workload_identity_pool" "e2e_broker" {
  count = local.broker_enabled ? 1 : 0

  workload_identity_pool_id = var.broker_pool_id
  display_name              = "Alethia e2e assertion broker"
  description               = "Trusts the dedicated E2E assertion broker (apps/e2e-issuer) for the e2e provisioner SA. Separate from the GitHub pool on purpose (#4226)."

  depends_on = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "e2e_broker" {
  count = local.broker_enabled ? 1 : 0

  workload_identity_pool_id          = google_iam_workload_identity_pool.e2e_broker[0].workload_identity_pool_id
  workload_identity_pool_provider_id = var.broker_provider_id
  display_name                       = "E2E assertion broker"

  # Only the subject is mapped. No `attribute.repository`, deliberately: nothing binds on it, and an
  # unmapped attribute cannot be matched by a principalSet someone adds later.
  attribute_mapping = {
    "google.subject" = "assertion.sub"
  }

  attribute_condition = local.broker_attr_condition

  oidc {
    issuer_uri        = var.e2e_broker_issuer_url
    allowed_audiences = [local.broker_audience]
  }

  lifecycle {
    # A REAL gate, unlike the checks in checks.tf: an unpinned workflow_ref would reduce the run
    # binding to "any workflow in this repo the broker accepts", so the plan refuses instead.
    precondition {
      condition = length(var.e2e_broker_workflow_refs) > 0 && alltrue([
        for r in var.e2e_broker_workflow_refs : startswith(r, "${var.github_repo}/.github/workflows/")
      ])
      error_message = "e2e_broker_workflow_refs must name at least one workflow ref, each under ${var.github_repo}/.github/workflows/ — the broker trust pins the run's workflow_ref exactly."
    }
  }
}

# ONE principal — the contract's subject in the broker pool — never a principalSet. `_iam_member` is
# additive (it manages this one member of the role binding), so it cannot drop e2e_wif's member the
# way an authoritative `_iam_binding` / `_iam_policy` would.
resource "google_service_account_iam_member" "e2e_broker" {
  count = local.broker_enabled ? 1 : 0

  service_account_id = google_service_account.e2e.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.broker_principal

  # The member names the pool by a BUILT name (local.broker_pool_name), which carries no dependency
  # edge; this orders the pool and its provider before the binding that names them.
  depends_on = [google_iam_workload_identity_pool_provider.e2e_broker]
}
