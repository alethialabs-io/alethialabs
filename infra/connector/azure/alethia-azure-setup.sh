#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# Keyless Azure connector setup — customer-side, no platform Entra app.
#
# Azure federation is implemented by Entra ID, but this creates NO App Registration and NO
# client secret. It creates, in YOUR subscription, a User-Assigned Managed Identity (a plain
# ARM resource — no directory-admin rights) with a federated-identity credential that trusts
# the Alethia OIDC issuer. Alethia authenticates AS that identity by presenting a short-lived
# assertion its issuer mints (subject `alethia-connector`, audience `api://AzureADTokenExchange`).
# You grant it a least-privilege role on the subscription and paste three public ids back —
# parity with the GCP Workload Identity Federation model. You store no secret.

set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <SUBSCRIPTION_ID> [ISSUER_URL]"
  echo ""
  echo "Run this in Azure Cloud Shell or locally with the az CLI installed. It creates the"
  echo "keyless managed-identity federation Alethia needs to provision into your subscription."
  exit 1
fi

SUBSCRIPTION_ID="$1"
# The Alethia OIDC issuer the managed identity federates off. Defaults to the hosted issuer;
# a self-hosted console passes its own (ALETHIA_ISSUER_URL env or arg 2). MUST match issuerUrl()
# (lib/oidc/issuer.ts).
ISSUER_URL="${ALETHIA_ISSUER_URL:-${2:-https://alethialabs.io/api/oidc}}"
# The fixed subject + audience the Alethia issuer mints — MUST match WORKLOAD_SUBJECT
# (lib/oidc/issuer.ts) and AZURE_TOKEN_AUDIENCE (lib/cloud-providers/session/azure.ts).
SUBJECT="alethia-connector"
AUDIENCE="api://AzureADTokenExchange"
# Region + names for the connector resource group + identity (metadata only; clusters land elsewhere).
# The region is functionally irrelevant — a UAMI is just an identity, federation doesn't care where it
# lives — but the subscription's Allowed-Locations Azure Policy still gates WHERE it can be created, and
# many subscriptions disallow `eastus`. So we don't hardcode: an explicit ALETHIA_AZURE_LOCATION wins,
# otherwise we auto-pick the first region the policy permits (see create_rg_in_allowed_location below).
CANDIDATE_LOCATIONS=("${ALETHIA_AZURE_LOCATION:-}" westeurope northeurope eastus westus2 uksouth germanywestcentral centralus)
LOCATION=""
RG_NAME="alethia-connector"
UAMI_NAME="alethia-provisioner"
FIC_NAME="alethia-connector"
ROLE_NAME="Alethia Provisioner"

echo "==> Setting subscription to ${SUBSCRIPTION_ID}"
az account set --subscription "${SUBSCRIPTION_ID}"

TENANT_ID=$(az account show --query tenantId -o tsv)
echo "    Tenant ID: ${TENANT_ID}"

# Resolve the resource-group region against the subscription's Allowed-Locations policy: reuse an
# existing RG's region on a re-run (region is fixed at creation), else try each candidate until one is
# allowed — skipping RequestDisallowedByAzure and surfacing any other error (auth/quota) verbatim.
create_rg_in_allowed_location() {
	local existing
	existing=$(az group show --name "${RG_NAME}" --query location -o tsv 2>/dev/null || true)
	if [ -n "${existing}" ]; then
		LOCATION="${existing}"
		echo "    Reusing existing resource group region: ${LOCATION}"
		return 0
	fi
	local loc err
	for loc in "${CANDIDATE_LOCATIONS[@]}"; do
		[ -z "${loc}" ] && continue
		if err=$(az group create --name "${RG_NAME}" --location "${loc}" -o none 2>&1); then
			LOCATION="${loc}"
			echo "    Resource group ${RG_NAME} created in ${LOCATION}"
			return 0
		fi
		if printf '%s' "${err}" | grep -qiE 'RequestDisallowedByAzure|disallowed'; then
			echo "    ${loc} is disallowed by your subscription's region policy — trying the next region..." >&2
			continue
		fi
		# A different failure (auth, quota, …) — surface it and stop.
		printf '%s\n' "${err}" >&2
		return 1
	done
	echo "✗ None of the candidate regions were allowed by your subscription's Allowed-Locations policy." >&2
	echo "  Re-run with an allowed region: ALETHIA_AZURE_LOCATION=<region> bash alethia-azure-setup.sh ${SUBSCRIPTION_ID}" >&2
	return 1
}

echo ""
echo "==> Creating resource group ${RG_NAME}..."
create_rg_in_allowed_location

echo ""
echo "==> Creating the User-Assigned Managed Identity ${UAMI_NAME} (${LOCATION})..."
# Idempotent — az identity create reconciles an existing identity.
az identity create --name "${UAMI_NAME}" --resource-group "${RG_NAME}" --location "${LOCATION}" -o none
CLIENT_ID=$(az identity show --name "${UAMI_NAME}" --resource-group "${RG_NAME}" --query clientId -o tsv)
PRINCIPAL_ID=$(az identity show --name "${UAMI_NAME}" --resource-group "${RG_NAME}" --query principalId -o tsv)
echo "    Client ID:    ${CLIENT_ID}"

echo ""
echo "==> Adding the federated credential (trusts the Alethia issuer)..."
# The credential that lets Alethia's minted assertion be exchanged for a token AS this identity.
if az identity federated-credential show \
  --name "${FIC_NAME}" --identity-name "${UAMI_NAME}" --resource-group "${RG_NAME}" &>/dev/null; then
  echo "    Federated credential already exists, updating."
  az identity federated-credential update \
    --name "${FIC_NAME}" --identity-name "${UAMI_NAME}" --resource-group "${RG_NAME}" \
    --issuer "${ISSUER_URL}" --subject "${SUBJECT}" --audiences "${AUDIENCE}" -o none
else
  az identity federated-credential create \
    --name "${FIC_NAME}" --identity-name "${UAMI_NAME}" --resource-group "${RG_NAME}" \
    --issuer "${ISSUER_URL}" --subject "${SUBJECT}" --audiences "${AUDIENCE}" -o none
  echo "    Federated credential created."
fi

echo ""
echo "==> Creating the least-privilege 'Alethia Provisioner' custom role..."
# Enumerates only the actions Alethia's project templates need — in place of Contributor
# (which is both over-broad AND lacks roleAssignments/write the templates require). Parity
# with infra/connector/azure/main.tf.
ROLE_JSON="$(mktemp)"
cat > "${ROLE_JSON}" <<JSON
{
  "Name": "${ROLE_NAME}",
  "Description": "Least-privilege provisioning role for Alethia — scoped to the services Alethia creates.",
  "Actions": [
    "Microsoft.Resources/subscriptions/resourceGroups/read","Microsoft.Resources/subscriptions/resourceGroups/write","Microsoft.Resources/subscriptions/resourceGroups/delete","Microsoft.Resources/subscriptions/read","Microsoft.Resources/subscriptions/resourceGroups/resources/read","Microsoft.Resources/deployments/*","*/register/action",
    "Microsoft.ContainerService/managedClusters/*","Microsoft.ContainerService/locations/*/read",
    "Microsoft.Network/virtualNetworks/*","Microsoft.Network/networkSecurityGroups/*","Microsoft.Network/publicIPAddresses/*","Microsoft.Network/natGateways/*","Microsoft.Network/routeTables/*","Microsoft.Network/dnsZones/*","Microsoft.Network/privateDnsZones/*","Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies/*",
    "Microsoft.DBforPostgreSQL/flexibleServers/*","Microsoft.Cache/redis/*","Microsoft.ContainerRegistry/registries/*","Microsoft.Storage/storageAccounts/*","Microsoft.ServiceBus/namespaces/*","Microsoft.DocumentDB/databaseAccounts/*",
    "Microsoft.ManagedIdentity/userAssignedIdentities/*",
    "Microsoft.KeyVault/vaults/*","Microsoft.KeyVault/locations/deletedVaults/purge/action","Microsoft.KeyVault/locations/operationResults/read",
    "Microsoft.Authorization/roleAssignments/read","Microsoft.Authorization/roleAssignments/write","Microsoft.Authorization/roleAssignments/delete","Microsoft.Authorization/roleDefinitions/read"
  ],
  "DataActions": ["Microsoft.KeyVault/vaults/secrets/*"],
  "NotActions": [],
  "AssignableScopes": ["/subscriptions/${SUBSCRIPTION_ID}"]
}
JSON
if az role definition list --name "${ROLE_NAME}" --query "[0].roleName" -o tsv 2>/dev/null | grep -q .; then
  az role definition update --role-definition "${ROLE_JSON}" -o none
else
  az role definition create --role-definition "${ROLE_JSON}" -o none
fi
rm -f "${ROLE_JSON}"
echo "    Custom role ready."

echo ""
echo "==> Waiting for the managed identity to propagate in Entra ID..."
sleep 15

echo ""
echo "==> Assigning it (constrained: may only grant the templates' least-priv roles, no self-escalation)..."
# ABAC condition: the identity may create/delete role assignments ONLY for the built-in, least-privilege
# roles the Alethia project templates actually assign — and nothing else. Owner / Contributor / User
# Access Administrator are deliberately NOT in this set, so there is no self-escalation path.
#   - DNS Zone Contributor (external-dns)                       — workload-identity.tf
#   - Key Vault Secrets User (external-secrets workload id)     — workload-identity.tf
#   - Key Vault Secrets Officer (provisioner seeds secrets)     — modules/key-vault
#   - Azure Kubernetes Service RBAC Cluster Admin               — modules/aks
# (A real apply proved the DNS-only condition too narrow: KV/AKS assignments 403'd — see #776.)
DNS_ZONE_CONTRIB="befefa01-2a29-4197-83a8-272ff33ce314"
KV_SECRETS_USER="4633458b-17de-408a-b874-0445c86b69e6"
KV_SECRETS_OFFICER="b86a8fe4-44ce-4948-aee5-eccb2c155cd7"
AKS_RBAC_ADMIN="b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b"
ASSIGNABLE_ROLES="${DNS_ZONE_CONTRIB}, ${KV_SECRETS_USER}, ${KV_SECRETS_OFFICER}, ${AKS_RBAC_ADMIN}"
CONDITION="((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${ASSIGNABLE_ROLES}})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${ASSIGNABLE_ROLES}}))"
EXISTING_ROLE=$(az role assignment list \
  --assignee "${PRINCIPAL_ID}" \
  --role "${ROLE_NAME}" \
  --scope "/subscriptions/${SUBSCRIPTION_ID}" \
  --query "[0].id" -o tsv 2>/dev/null || true)
if [ -n "${EXISTING_ROLE}" ]; then
  # Re-apply idempotently: DELETE + recreate so an updated ABAC condition (e.g. the expanded
  # least-privilege role set) actually takes effect — Azure can't update an assignment's condition
  # in place, and a plain "skip if exists" would strand the old (too-narrow) condition on re-run.
  echo "    Existing assignment found — re-applying (the least-priv condition may have changed)..."
  az role assignment delete --ids "${EXISTING_ROLE}" -o none || true
fi
az role assignment create \
  --assignee-object-id "${PRINCIPAL_ID}" \
  --assignee-principal-type ServicePrincipal \
  --role "${ROLE_NAME}" \
  --scope "/subscriptions/${SUBSCRIPTION_ID}" \
  --condition "${CONDITION}" \
  --condition-version "2.0" \
  -o none
echo "    Least-privilege role assigned (condition applied)."

echo ""
echo "============================================================"
echo "  Setup complete! (keyless, customer-side managed identity)"
echo "============================================================"
echo ""
echo "Copy these values into the Alethia dashboard:"
echo ""
echo "  Tenant ID:       ${TENANT_ID}"
echo "  Subscription ID: ${SUBSCRIPTION_ID}"
echo "  Client ID:       ${CLIENT_ID}"
echo ""
echo "--- START CONFIG (machine-readable, parsed by the Alethia CLI) ---"
echo "tenant_id=${TENANT_ID}"
echo "client_id=${CLIENT_ID}"
echo "subscription_id=${SUBSCRIPTION_ID}"
echo "--- END CONFIG ---"
