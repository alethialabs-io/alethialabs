#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Keyless GCP connector setup — DIRECT OIDC federation from the Alethia issuer.
# Creates a Workload Identity Pool with an OIDC provider that trusts Alethia's control-plane
# issuer directly (no AWS hop), pinned to the fixed workload subject + audience the console
# mints, binds a provisioner service account, and prints an external_account credential config.
# Alethia authenticates by presenting a short-lived minted JWT it writes to a token file that
# google-auth re-reads — no service-account key, no static credential.
set -euo pipefail

ISSUER_URL="${ALETHIA_ISSUER_URL:-${2:-https://alethialabs.io/api/oidc}}"
AUDIENCE="${ALETHIA_GCP_AUDIENCE:-alethia-gcp-wif}" # must equal GCP_TOKEN_AUDIENCE (session/gcp.ts)
SUBJECT="alethia-connector"                         # must equal WORKLOAD_SUBJECT (lib/oidc/issuer.ts)
POOL_ID="alethia-pool"
PROVIDER_ID="alethia-oidc-provider"
SA_NAME="alethia-provisioner"
# Placeholder token path — Alethia's runner overrides credential_source.file with its own temp
# file at provision time; the console supplies the token programmatically (ignores this path).
TOKEN_FILE="/var/run/alethia/gcp-oidc-token"

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <GCP_PROJECT_ID> [ISSUER_URL]"
  echo ""
  echo "Run this in Google Cloud Shell or locally with gcloud installed. It creates the"
  echo "keyless OIDC federation Alethia needs to provision into your project."
  exit 1
fi

PROJECT_ID="$1"

echo "==> Setting project to ${PROJECT_ID}"
gcloud config set project "${PROJECT_ID}"

PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)")
echo "    Project number: ${PROJECT_NUMBER}"

echo ""
echo "==> Enabling required APIs..."
gcloud services enable \
  iam.googleapis.com \
  sts.googleapis.com \
  iamcredentials.googleapis.com \
  compute.googleapis.com \
  container.googleapis.com \
  dns.googleapis.com \
  cloudresourcemanager.googleapis.com

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo ""
echo "==> Creating service account ${SA_NAME}..."
if gcloud iam service-accounts describe "${SA_EMAIL}" &>/dev/null; then
  echo "    Service account already exists, skipping."
else
  gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="Alethia Provisioner" \
    --description="Used by Alethia to provision GKE clusters and Google Cloud resources"
fi

echo ""
echo "==> Granting least-privilege provisioning roles to the service account..."
# Enumerated predefined roles covering exactly the services Alethia provisions —
# in place of account-wide roles/editor. Matches infra/connector/gcp/main.tf.
for ROLE in \
  roles/container.admin \
  roles/compute.networkAdmin \
  roles/compute.securityAdmin \
  roles/servicenetworking.networksAdmin \
  roles/cloudsql.admin \
  roles/redis.admin \
  roles/dns.admin \
  roles/artifactregistry.admin \
  roles/secretmanager.admin \
  roles/storage.admin \
  roles/datastore.owner \
  roles/pubsub.admin \
  roles/iam.serviceAccountAdmin \
  roles/iam.serviceAccountUser \
  roles/browser; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${ROLE}" \
    --condition=None \
    --quiet >/dev/null
done
echo "    Granted ${PROJECT_ID} provisioning roles."

echo ""
echo "==> Creating Workload Identity Pool..."
if gcloud iam workload-identity-pools describe "${POOL_ID}" \
  --location="global" &>/dev/null; then
  echo "    Pool already exists, skipping."
else
  gcloud iam workload-identity-pools create "${POOL_ID}" \
    --location="global" \
    --display-name="Alethia Identity Pool" \
    --description="Trusts the Alethia OIDC issuer for keyless federation"
fi

echo ""
echo "==> Creating OIDC provider (trusting the Alethia issuer)..."
if gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" \
  --location="global" \
  --workload-identity-pool="${POOL_ID}" &>/dev/null; then
  echo "    Provider already exists, skipping."
else
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_ID}" \
    --location="global" \
    --workload-identity-pool="${POOL_ID}" \
    --issuer-uri="${ISSUER_URL}" \
    --allowed-audiences="${AUDIENCE}" \
    --attribute-mapping="google.subject=assertion.sub" \
    --display-name="Alethia OIDC Provider"
fi

# Bind ONLY the fixed workload subject (not the whole pool) to the provisioner SA.
PRINCIPAL="principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/subject/${SUBJECT}"

echo ""
echo "==> Waiting for IAM propagation..."
sleep 10

echo ""
echo "==> Granting workload identity user binding (subject ${SUBJECT})..."
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="${PRINCIPAL}" \
  --quiet

OUTPUT_FILE="alethia-wif-config.json"

echo ""
echo "==> Generating credential configuration (OIDC token file source)..."
gcloud iam workload-identity-pools create-cred-config \
  "projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}" \
  --service-account="${SA_EMAIL}" \
  --credential-source-file="${TOKEN_FILE}" \
  --credential-source-type="text" \
  --output-file="${OUTPUT_FILE}"

echo ""
echo "============================================================"
echo "  Setup complete! (keyless, direct-OIDC)"
echo "============================================================"
echo ""
echo "--- START CONFIG (copy everything below until END CONFIG) ---"
cat "${OUTPUT_FILE}"
echo ""
echo "--- END CONFIG ---"
