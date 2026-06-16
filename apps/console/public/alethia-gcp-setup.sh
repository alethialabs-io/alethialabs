#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail

VERTEX_AWS_ACCOUNT_ID="787587782604"
POOL_ID="alethia-pool"
PROVIDER_ID="alethia-aws-provider"
SA_NAME="alethia-provisioner"

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <GCP_PROJECT_ID>"
  echo ""
  echo "Run this script in Google Cloud Shell or locally with gcloud installed."
  echo "It creates the resources Alethia needs to provision infrastructure in your project."
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
echo "==> Granting roles/editor to the service account..."
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/editor" \
  --condition=None \
  --quiet

echo ""
echo "==> Creating Workload Identity Pool..."
if gcloud iam workload-identity-pools describe "${POOL_ID}" \
  --location="global" &>/dev/null; then
  echo "    Pool already exists, skipping."
else
  gcloud iam workload-identity-pools create "${POOL_ID}" \
    --location="global" \
    --display-name="Alethia Identity Pool" \
    --description="Allows Alethia workers to authenticate from AWS"
fi

echo ""
echo "==> Creating AWS provider in the pool..."
if gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" \
  --location="global" \
  --workload-identity-pool="${POOL_ID}" &>/dev/null; then
  echo "    Provider already exists, skipping."
else
  gcloud iam workload-identity-pools providers create-aws "${PROVIDER_ID}" \
    --location="global" \
    --workload-identity-pool="${POOL_ID}" \
    --account-id="${VERTEX_AWS_ACCOUNT_ID}" \
    --display-name="Alethia AWS Provider"
fi

PRINCIPAL="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/*"

echo ""
echo "==> Waiting for IAM propagation..."
sleep 10

echo ""
echo "==> Granting workload identity user binding..."
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="${PRINCIPAL}" \
  --quiet

OUTPUT_FILE="alethia-wif-config.json"

echo ""
echo "==> Generating credential configuration..."
gcloud iam workload-identity-pools create-cred-config \
  "projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}" \
  --service-account="${SA_EMAIL}" \
  --aws \
  --output-file="${OUTPUT_FILE}"

echo ""
echo "============================================================"
echo "  Setup complete!"
echo "============================================================"
echo ""
echo "Copy the contents of ${OUTPUT_FILE} and paste them into the"
echo "Alethia dashboard to complete the connection."
echo ""
echo "--- START CONFIG (copy everything below until END CONFIG) ---"
cat "${OUTPUT_FILE}"
echo ""
echo "--- END CONFIG ---"
