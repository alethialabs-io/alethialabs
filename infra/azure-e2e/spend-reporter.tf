# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# ── The weekly spend report's Azure identity ───────────────────────────────────────────────────
# A SEPARATE application, not a grant on the e2e SP, and the reason is that SP's reach. The e2e SP
# holds Contributor + User Access Administrator on this subscription (roles.tf) — escalation-capable
# by design, so it can provision a whole AKS estate. Contributor already carries Cost Management
# reads, so the cheapest change would have been to federate the report into it; that would hand a
# weekly read-only email job a token that can grant Owner. This application holds ONE built-in role,
# Cost Management Reader, on the same subscription and nothing else.
#
# TRUST: one federated credential, the spend-report ENVIRONMENT subject. The environment is
# restricted to `main` (infra/github/environments.tf), and it is the only subject the report job
# presents. The e2e SP's own credentials (main.tf) are untouched — applying this file adds three
# resources and modifies none.

locals {
  spend_reporter_subject = "repo:${var.github_repo}:environment:${var.spend_reporter_github_environment}"
}

resource "azuread_application" "spend_reporter" {
  display_name = "${var.name_prefix}-spend-reporter"
  description  = "Alethia weekly spend report (spend-report.yml): Cost Management Reader on the e2e subscription, nothing else. Federated to GitHub OIDC (spend-report environment). See infra/azure-e2e/spend-reporter.tf."
  owners       = [data.azuread_client_config.current.object_id]
}

resource "azuread_service_principal" "spend_reporter" {
  client_id                    = azuread_application.spend_reporter.client_id
  app_role_assignment_required = false
  owners                       = [data.azuread_client_config.current.object_id]
}

resource "azuread_application_federated_identity_credential" "spend_reporter" {
  application_id = azuread_application.spend_reporter.id
  display_name   = "gh-oidc-spend-report"
  description    = "GitHub Actions OIDC — ${local.spend_reporter_subject}"
  audiences      = [local.token_audience]
  issuer         = local.github_oidc_issuer
  subject        = local.spend_reporter_subject
}

# Read cost data and budgets; no write, no role assignment, no resource reads beyond cost. Same
# scope as every assignment in roles.tf: the subscription, nothing wider.
resource "azurerm_role_assignment" "spend_reporter_cost_reader" {
  scope                = local.subscription_scope
  role_definition_name = "Cost Management Reader"
  principal_id         = azuread_service_principal.spend_reporter.object_id
  principal_type       = "ServicePrincipal"
}
