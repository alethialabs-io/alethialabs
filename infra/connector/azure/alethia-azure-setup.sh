#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# Keyless Azure connector setup. Alethia registers ONE multi-tenant Entra app whose
# federated-identity credential trusts the Alethia OIDC issuer — the console + runner
# authenticate AS that app with a minted assertion (no client secret anywhere). This
# script does NOT create an app or a federated credential; it only creates a service
# principal for Alethia's app in YOUR tenant and grants it Contributor on your
# subscription. You store nothing — copy the Tenant ID + Subscription ID back to Alethia.

set -euo pipefail

# The Application (client) ID of Alethia's platform app. The connect UI bakes this into the
# command it shows you; override here if you're self-hosting a different platform app.
ALETHIA_AZURE_CLIENT_ID="${ALETHIA_AZURE_CLIENT_ID:-}"

if [ -z "${1:-}" ]; then
  echo "Usage: ALETHIA_AZURE_CLIENT_ID=<app-id> $0 <SUBSCRIPTION_ID>"
  echo ""
  echo "Run this script in Azure Cloud Shell or locally with az CLI installed."
  echo "It authorizes Alethia's app to provision infrastructure in your subscription."
  exit 1
fi

if [ -z "${ALETHIA_AZURE_CLIENT_ID}" ]; then
  echo "ERROR: ALETHIA_AZURE_CLIENT_ID is not set."
  echo "Copy the exact command shown in the Alethia connect dialog — it includes the app id."
  exit 1
fi

SUBSCRIPTION_ID="$1"
CLIENT_ID="${ALETHIA_AZURE_CLIENT_ID}"

echo "==> Setting subscription to ${SUBSCRIPTION_ID}"
az account set --subscription "${SUBSCRIPTION_ID}"

TENANT_ID=$(az account show --query tenantId -o tsv)
echo "    Tenant ID: ${TENANT_ID}"

echo ""
echo "==> Creating a service principal for Alethia's app (${CLIENT_ID})..."
EXISTING_SP=$(az ad sp list --filter "appId eq '${CLIENT_ID}'" --query "[0].id" -o tsv 2>/dev/null || true)

if [ -n "${EXISTING_SP}" ] && [ "${EXISTING_SP}" != "None" ]; then
  SP_OBJECT_ID="${EXISTING_SP}"
  echo "    Service principal already exists, skipping."
else
  # Creates the SP for Alethia's multi-tenant app in THIS tenant (no new app is registered).
  az ad sp create --id "${CLIENT_ID}" -o none
  echo "    Service principal created."
  echo "==> Waiting for Azure AD propagation..."
  sleep 10
  SP_OBJECT_ID=$(az ad sp list --filter "appId eq '${CLIENT_ID}'" --query "[0].id" -o tsv)
fi

echo ""
echo "==> Creating the least-privilege 'Alethia Provisioner' custom role..."
# Enumerates only the actions Alethia's project templates need — in place of Contributor
# (which is both over-broad AND lacks roleAssignments/write the templates require). Parity
# with infra/connector/azure/main.tf.
ROLE_NAME="Alethia Provisioner"
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
echo "==> Assigning it (constrained: may only grant DNS Zone Contributor, no self-escalation)..."
# ABAC condition: the SP can create/delete role assignments ONLY for DNS Zone Contributor
# (befefa01-2a29-4197-83a8-272ff33ce314) — the external-dns identity the templates create —
# and nothing else (no path to Owner).
DNS_ZONE_CONTRIB="befefa01-2a29-4197-83a8-272ff33ce314"
CONDITION="((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${DNS_ZONE_CONTRIB}})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${DNS_ZONE_CONTRIB}}))"
EXISTING_ROLE=$(az role assignment list \
  --assignee "${SP_OBJECT_ID}" \
  --role "${ROLE_NAME}" \
  --scope "/subscriptions/${SUBSCRIPTION_ID}" \
  --query "[0].id" -o tsv 2>/dev/null || true)
if [ -n "${EXISTING_ROLE}" ]; then
  echo "    Role assignment already exists, skipping."
else
  az role assignment create \
    --assignee-object-id "${SP_OBJECT_ID}" \
    --assignee-principal-type ServicePrincipal \
    --role "${ROLE_NAME}" \
    --scope "/subscriptions/${SUBSCRIPTION_ID}" \
    --condition "${CONDITION}" \
    --condition-version "2.0" \
    -o none
  echo "    Least-privilege role assigned."
fi

echo ""
echo "============================================================"
echo "  Setup complete!"
echo "============================================================"
echo ""
echo "Copy these values into the Alethia dashboard:"
echo ""
echo "  Tenant ID:       ${TENANT_ID}"
echo "  Subscription ID: ${SUBSCRIPTION_ID}"
echo ""
