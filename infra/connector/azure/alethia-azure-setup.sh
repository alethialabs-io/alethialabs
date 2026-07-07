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
echo "==> Assigning Contributor role on subscription..."
EXISTING_ROLE=$(az role assignment list \
  --assignee "${SP_OBJECT_ID}" \
  --role "Contributor" \
  --scope "/subscriptions/${SUBSCRIPTION_ID}" \
  --query "[0].id" -o tsv 2>/dev/null || true)

if [ -n "${EXISTING_ROLE}" ]; then
  echo "    Role assignment already exists, skipping."
else
  az role assignment create \
    --assignee-object-id "${SP_OBJECT_ID}" \
    --assignee-principal-type ServicePrincipal \
    --role "Contributor" \
    --scope "/subscriptions/${SUBSCRIPTION_ID}" \
    -o none
  echo "    Contributor role assigned."
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
