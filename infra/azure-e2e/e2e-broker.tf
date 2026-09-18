# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# #4226 — let the e2e service principal accept a short-lived assertion minted by the dedicated E2E
# assertion broker (apps/e2e-issuer, contract in packages/workload-identity/src/broker.ts), in
# ADDITION to the GitHub Actions federated credentials in main.tf.
#
# OFF BY DEFAULT. `e2e_broker_issuer_url = null` (the committed value in terraform.tfvars) creates
# nothing, so a plan on this change alone is a no-op. Setting it creates ONE more federated identity
# credential on the same application; setting it back to null destroys exactly that one. Each
# credential is its own object in Entra, so adding or removing this one cannot touch `gh-oidc-*`.
#
# WHAT ENTRA CAN PIN. A federated identity credential matches three fields exactly — issuer, subject
# and audience — and nothing else about the token:
#
#   issuer    — var.e2e_broker_issuer_url, compared as an exact string against the token's `iss`
#               (so the variable admits only the bare origin the Worker stamps there)
#   audience  — `api://AzureADTokenExchange`, read from WORKLOAD_PROVIDER_AUDIENCES
#   subject   — `alethia-connector`, read from WORKLOAD_SUBJECT
#
# The run binding (repository, workflow_ref, run_id, run_attempt) rides in custom claims Entra does
# not read; the BROKER enforces it before it signs (ALLOWED_REPOSITORIES, ALLOWED_WORKFLOW_REFS, the
# GitHub-token cross-check and the replay guard in apps/e2e-issuer/src/worker.ts).
#
# LIFETIME. Entra has no per-credential knob for the incoming assertion's lifetime; it refuses an
# expired one. The broker caps the assertion at 60–600s (MIN_/MAX_ASSERTION_TTL_SECONDS, enforced by
# brokerAssertionRequestSchema); the access token Entra issues in exchange has Entra's own lifetime.
#
# Applied by the maintainer only; see docs/testing/e2e-federation-apply-runbook.md.

locals {
  # The ONE copy of the broker contract is TypeScript. Read it rather than restate it (#4236: a
  # hand-typed second copy of these audiences failed the nightly with no repo diff to explain it).
  # A moved file or a changed shape makes `regex` fail and the plan error before anything applies.
  broker_contract  = file("${path.module}/../../packages/workload-identity/src/broker.ts")
  broker_audiences = regex("WORKLOAD_PROVIDER_AUDIENCES[^=]*=\\s*\\{([^}]*)\\}", local.broker_contract)[0]
  broker_audience  = regex("\\bazure:\\s*\"([^\"]+)\"", local.broker_audiences)[0]
  broker_subject   = regex("WORKLOAD_SUBJECT\\s*=\\s*\"([^\"]+)\"", local.broker_contract)[0]

  broker_enabled = var.e2e_broker_issuer_url != null
}

resource "azuread_application_federated_identity_credential" "e2e_broker" {
  count = local.broker_enabled ? 1 : 0

  application_id = azuread_application.e2e.id
  display_name   = "e2e-assertion-broker"
  description    = "E2E assertion broker (apps/e2e-issuer) — ${local.broker_subject}. #4226."
  audiences      = [local.broker_audience]
  issuer         = var.e2e_broker_issuer_url
  subject        = local.broker_subject
}
