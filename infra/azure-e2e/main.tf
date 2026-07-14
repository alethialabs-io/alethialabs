# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# infra/azure-e2e — the maintainer federated-identity stack that lets the T2 real-cloud nightly
# (.github/workflows/e2e-nightly.yml) stand up + tear down a genuine, ephemeral AKS estate from
# infra/templates/project/azure. The Azure analogue of infra/aws-oidc's `alethia-e2e-nightly` role.
#
# It creates, in a DEDICATED e2e subscription:
#   * an Entra application + service principal (the ARM_CLIENT_ID the nightly uses), federated to
#     GitHub Actions OIDC (issuer token.actions.githubusercontent.com, subject bound EXACTLY to
#     repo:<repo>:ref:refs/heads/<branch>, audience api://AzureADTokenExchange) — NO client secret;
#   * subscription-scoped role assignments (Contributor + User Access Administrator + AKS Cluster
#     User) — see roles.tf;
#   * an Entra ADMIN GROUP whose object id feeds the AKS e2e self-admin fix (admin-group.tf +
#     packages/core/cloud/azure_provider.go resolveAKSAdminGroupObjectIDs) — the e2e SP is a member,
#     so its AAD token is authorized as cluster-admin on the fresh AKS at create time;
#   * a monthly consumption budget + action group cost kill-signal (budget.tf).
#
# ── Security model: subscription is the boundary ─────────────────────────────────────────────
# A provisioning identity is inherently broad — you cannot enumerate a least-privilege action list
# for "build + destroy a whole AKS estate" without it breaking on the next template change. AWS caps
# this with a permissions boundary + region lock; AZURE HAS NO PERMISSIONS BOUNDARY. So the wall here
# is the SUBSCRIPTION: every grant is scoped to var.subscription_id only, which MUST be a dedicated
# e2e subscription (see variables.tf + README). The real containment — as on AWS — is the ref-bound
# OIDC federation: only trusted-branch Actions runs can federate into the SP.
#
# Applied ONCE by the maintainer with an admin identity (invariant 4: `tofu apply` on infra/ IAM
# stacks is maintainer-only). Agents never apply.

data "azurerm_subscription" "current" {}

data "azuread_client_config" "current" {}

locals {
  subscription_scope = data.azurerm_subscription.current.id

  # The EXACT GitHub OIDC subjects allowed to federate into the SP. `schedule` runs on the default
  # branch (main); a `workflow_dispatch` from that branch mints the same ref sub. Azure federated
  # credentials take ONE subject each (no value-lists), so we create one credential per subject.
  federated_subjects = merge(
    { ref = "repo:${var.github_repo}:ref:refs/heads/${var.e2e_github_branch}" },
    var.e2e_github_environment != "" ? { env = "repo:${var.github_repo}:environment:${var.e2e_github_environment}" } : {},
  )

  github_oidc_issuer = "https://token.actions.githubusercontent.com"
  # The AWS-STS-analogue audience GitHub tokens are exchanged for in Entra.
  token_audience = "api://AzureADTokenExchange"
}

# ── The e2e Entra application + service principal (the nightly's ARM_CLIENT_ID) ───────────────
resource "azuread_application" "e2e" {
  display_name = "${var.name_prefix}-nightly"
  description  = "Alethia T2 real-cloud nightly: provisions + tears down an ephemeral AKS estate. Federated to GitHub OIDC (ref-bound). Subscription-scoped. See infra/azure-e2e."
  owners       = [data.azuread_client_config.current.object_id]
}

resource "azuread_service_principal" "e2e" {
  client_id                    = azuread_application.e2e.client_id
  app_role_assignment_required = false
  owners                       = [data.azuread_client_config.current.object_id]
}

# ── Federated identity credential(s): GitHub OIDC, subject-bound, keyless ─────────────────────
# One per exact subject in local.federated_subjects. No client secret is ever created — the nightly
# presents a GitHub-minted OIDC token and Entra exchanges it for an SP token.
resource "azuread_application_federated_identity_credential" "github" {
  for_each = local.federated_subjects

  application_id = azuread_application.e2e.id
  display_name   = "gh-oidc-${each.key}"
  description    = "GitHub Actions OIDC — ${each.value}"
  audiences      = [local.token_audience]
  issuer         = local.github_oidc_issuer
  subject        = each.value
}
