<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# azure-e2e

The maintainer **federated-identity stack** that enables the Azure T2 real-cloud nightly
(`.github/workflows/e2e-nightly.yml`, `provider=azure`) to stand up + tear down a genuine,
ephemeral **AKS estate** from `infra/templates/project/azure`. The Azure analogue of
`infra/aws-oidc`'s `alethia-e2e-nightly` role (BYOC A1.1) — this is **A2.2**.

| Object | Purpose |
|---|---|
| `azuread_application` + `azuread_service_principal` (`main.tf`) | The nightly's `ARM_CLIENT_ID` — **keyless** (no client secret) |
| `azuread_application_federated_identity_credential` (`main.tf`) | GitHub-OIDC federation, subject **exactly** `repo:<repo>:ref:refs/heads/<branch>`, audience `api://AzureADTokenExchange` |
| `azurerm_role_assignment` ×3 (`roles.tf`) | Contributor + User Access Administrator + AKS Cluster User — **subscription-scoped only** |
| `azuread_group` + `azuread_group_member` (`admin-group.tf`) | The **AKS admin group** (SP is a member) whose object id authorizes the runner's AAD token as cluster-admin |
| `azurerm_consumption_budget_subscription` + `azurerm_monitor_action_group` (`budget.tf`) | Monthly cost kill-signal (50/80/100 % actual + 100 % forecast) |

## Security model — the subscription is the boundary

A provisioning identity is inherently broad; you cannot enumerate a least-privilege action list for
"build + destroy a whole AKS estate" without it breaking on the next template change. AWS caps this
with a permissions boundary + region lock. **Azure has no permissions boundary.** So the wall here is
the **subscription**: every grant is scoped to `var.subscription_id` and nothing wider, and that
subscription **must be a dedicated e2e subscription** — the Azure analogue of a dedicated AWS account.

`User Access Administrator` is escalation-capable (the templates legitimately create role assignments
— external-dns + workload-identity federation — which Contributor forbids). That is exactly why the
subscription must be a throwaway: the SP can escalate only inside that blast radius. The real
containment — as on AWS — is the **ref-bound OIDC federation**: only trusted-branch Actions runs can
federate in, so *"who can run the nightly"* ≈ *"who has latent admin in the e2e subscription."*

Every guardrail is asserted in `checks.tf` (exact subject, subscription-scoped assignments, admin
group wired, budget capped).

## The AKS self-admin fix (why this stack has an admin group)

Managed AKS with AAD-integrated RBAC only renders its authorization block when
`admin_group_object_ids` is **non-empty** (`infra/templates/project/azure/modules/aks/main.tf`). On
the default (empty) the runner's short-lived AAD token **401s** the fresh API server → ArgoCD can't
be installed — the same "runner never authorized" failure seen on EKS/GKE. This stack outputs an
**Entra admin group** (with the e2e SP as a member); wiring its object id into the cluster JSON makes
`packages/core/cloud/azure_provider.go` (`resolveAKSAdminGroupObjectIDs`) set
`aks_admin_group_object_ids`, so the runner is authorized as cluster-admin **at create time**.

## Apply (once, with an admin identity)

This is a bootstrap: it creates an Entra app + subscription role assignments, so it needs an admin
(Owner or User Access Administrator + Application Administrator on the tenant) the first time.

```bash
az login
cp terraform.tfvars.example terraform.tfvars     # set subscription_id (dedicated!) + emails
cp backend.hcl.example backend.hcl               # or `tofu init -backend=false` for local state
tofu init -backend-config=backend.hcl
tofu apply
```

## Enable the Azure nightly (maintainer runbook)

```bash
# 1. Apply the stack (above).

# 2. Publish the three creds as repo Actions VARIABLES the nightly gates on (mirrors E2E_AWS_ROLE_ARN).
gh variable set E2E_AZURE_CLIENT_ID       -b "$(tofu output -raw e2e_azure_client_id)"
gh variable set E2E_AZURE_TENANT_ID       -b "$(tofu output -raw e2e_azure_tenant_id)"
gh variable set E2E_AZURE_SUBSCRIPTION_ID -b "$(tofu output -raw e2e_azure_subscription_id)"

# 3. Wire the AKS self-admin group object id (BYOC A2.2). The azure nightly reads it and drops it into
#    the cluster snapshot's provider_config.aks_admin_group_object_ids (test/e2e t2MergeAzureAdminGroup),
#    which azure_provider.go maps to the template's aks_admin_group_object_ids tfvar.
gh variable set ALETHIA_E2E_AZURE_ADMIN_GROUP_OBJECT_ID -b "$(tofu output -raw aks_admin_group_object_id)"
#    (Alternative: fold the object id straight into ALETHIA_E2E_CLUSTER_JSON as
#     {"cluster_admins":[{"username":"e2e","groups":["<object-id>"]}]} or
#     {"provider_config":{"aks_admin_group_object_ids":["<object-id>"]}} — both flow through.)

# 4. Kick a run + watch.
gh workflow run e2e-nightly.yml -f provider=azure
gh run watch "$(gh run list --workflow=e2e-nightly.yml -L1 --json databaseId -q '.[0].databaseId')"

# 5. Kill-drill: hard-cancel a run mid-provision, then confirm the always() sweeper reclaimed
#    everything (nothing billable survives; the sweeper fails the step on any leak).
ALETHIA_E2E_ENV=<run_id>-<attempt> ALETHIA_E2E_REGION=germanywestcentral \
  DRY_RUN=1 ./scripts/e2e/azure-cleanup.sh     # dry-run first, then without DRY_RUN

# 6. Gate = cron: once green + the kill-drill passes, add `azure` to the nightly cron matrix.
```

Until `E2E_AZURE_CLIENT_ID` is set, the Azure path of `e2e-nightly.yml` **green-skips** (mirrors the
AWS `E2E_AWS_ROLE_ARN` / Hetzner `HCLOUD_TOKEN` gates).

### Teardown guarantee

The nightly runs `scripts/e2e/azure-cleanup.sh` in an `always()` step. It pivots on the **resource
group**: the template's `rg-<project>-<env>` (handle-tagged `alethia:project-id=e2e-<env>`) plus the
AKS-managed node RG (`MC_…`). Deleting the RG cascades to everything inside it; the sweeper refuses to
delete any group that neither carries the handle tag nor embeds this run's unique `-<env>`, and fails
the step (`::error::`) on any billable survivor. `PREFLIGHT=1` sweeps prior-run orphans before
provisioning. See the script header for the full safety contract.
