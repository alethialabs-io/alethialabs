#!/usr/bin/env bash
set -euo pipefail

VERTEX_AWS_ACCOUNT_ID="787587782604"
APP_NAME="alethia-provisioner"

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <SUBSCRIPTION_ID>"
  echo ""
  echo "Run this script in Azure Cloud Shell or locally with az CLI installed."
  echo "It creates the resources Alethia needs to provision infrastructure in your subscription."
  exit 1
fi

SUBSCRIPTION_ID="$1"

echo "==> Setting subscription to ${SUBSCRIPTION_ID}"
az account set --subscription "${SUBSCRIPTION_ID}"

TENANT_ID=$(az account show --query tenantId -o tsv)
echo "    Tenant ID: ${TENANT_ID}"

echo ""
echo "==> Creating App Registration..."
EXISTING_APP=$(az ad app list --display-name "${APP_NAME}" --query "[0].appId" -o tsv 2>/dev/null || true)

if [ -n "${EXISTING_APP}" ] && [ "${EXISTING_APP}" != "None" ]; then
  CLIENT_ID="${EXISTING_APP}"
  echo "    App already exists (${CLIENT_ID}), skipping."
else
  CLIENT_ID=$(az ad app create --display-name "${APP_NAME}" --query appId -o tsv)
  echo "    Created app with Client ID: ${CLIENT_ID}"
fi

echo ""
echo "==> Creating Service Principal..."
EXISTING_SP=$(az ad sp list --filter "appId eq '${CLIENT_ID}'" --query "[0].id" -o tsv 2>/dev/null || true)

if [ -n "${EXISTING_SP}" ] && [ "${EXISTING_SP}" != "None" ]; then
  echo "    Service principal already exists, skipping."
else
  az ad sp create --id "${CLIENT_ID}" -o none
  echo "    Service principal created."
fi

echo ""
echo "==> Waiting for Azure AD propagation..."
sleep 10

echo ""
echo "==> Creating Federated Identity Credential..."
EXISTING_FIC=$(az ad app federated-credential list --id "${CLIENT_ID}" --query "[?name=='alethia-aws-federation'].name" -o tsv 2>/dev/null || true)

if [ -n "${EXISTING_FIC}" ]; then
  echo "    Federated credential already exists, skipping."
else
  az ad app federated-credential create --id "${CLIENT_ID}" --parameters '{
    "name": "alethia-aws-federation",
    "issuer": "https://sts.amazonaws.com",
    "subject": "'"${VERTEX_AWS_ACCOUNT_ID}"'",
    "audiences": ["api://AzureADTokenExchange"],
    "description": "Trust Alethia AWS runners to authenticate as this app"
  }' -o none
  echo "    Federated credential created."
fi

echo ""
echo "==> Assigning Contributor role on subscription..."
SP_OBJECT_ID=$(az ad sp list --filter "appId eq '${CLIENT_ID}'" --query "[0].id" -o tsv)

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
echo "  Client ID:       ${CLIENT_ID}"
echo "  Subscription ID: ${SUBSCRIPTION_ID}"
echo ""
