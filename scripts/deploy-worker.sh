#!/bin/bash
set -euo pipefail

AWS_REGION="eu-west-1"
ECR_REPOSITORY="grape-worker-dev-grape"
ECS_CLUSTER="grape-worker-dev-cluster"
ECS_SERVICE="grape-worker-dev-service"
IAM_AUTH_VERSION="0.6.30"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GRAPE_DIR="${REPO_ROOT}/apps/grape"
GIT_SHA=$(git -C "${REPO_ROOT}" rev-parse --short HEAD)
TAG="${1:-${GIT_SHA}}"
WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"

# Base: alpine/k8s has kubectl, helm, git, bash, curl (all static/musl — no glibc needed)
BASE_IMAGE="alpine/k8s:1.31.4"

echo "==> Authenticating crane to ECR..."
aws ecr get-login-password --region "${AWS_REGION}" \
  | crane auth login "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com" --username AWS --password-stdin

echo "==> Cross-compiling grape-worker (linux/amd64)..."
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
  -C "${GRAPE_DIR}" \
  -ldflags="-s -w" \
  -o "${WORK}/grape" \
  ./cmd/grape-worker

echo "==> Downloading aws-iam-authenticator v${IAM_AUTH_VERSION} (static binary, replaces aws eks get-token)..."
curl -fsSL "https://github.com/kubernetes-sigs/aws-iam-authenticator/releases/download/v${IAM_AUTH_VERSION}/aws-iam-authenticator_${IAM_AUTH_VERSION}_linux_amd64" \
  -o "${WORK}/aws-iam-authenticator"
chmod +x "${WORK}/aws-iam-authenticator"

echo "==> Downloading terraform..."
TERRAFORM_VERSION="1.15.5"
curl -fsSL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" \
  -o "${WORK}/terraform.zip"
(cd "${WORK}" && unzip -qo terraform.zip terraform && rm terraform.zip)

echo "==> Downloading infracost..."
INFRACOST_VERSION="0.10.39"
curl -fsSL "https://github.com/infracost/infracost/releases/download/v${INFRACOST_VERSION}/infracost-linux-amd64.tar.gz" \
  | tar -xz -C "${WORK}"

# --- Build overlay layer ---
echo "==> Packing overlay layer..."
LAYER="${WORK}/layer.tar.gz"
(
  cd "${WORK}"
  mkdir -p _root/usr/local/bin _root/home/grape/.grape/bin _root/tmp
  chmod 1777 _root/tmp

  cp grape                 _root/usr/local/bin/grape
  cp terraform             _root/usr/local/bin/terraform
  cp infracost-linux-amd64 _root/usr/local/bin/infracost
  cp aws-iam-authenticator _root/usr/local/bin/aws-iam-authenticator
  chmod +x _root/usr/local/bin/*

  cp -r "${REPO_ROOT}/packages/templates"          _root/home/grape/templates
  cp -r "${REPO_ROOT}/packages/templates-worker"    _root/home/grape/templates-worker
  cp -r "${REPO_ROOT}/packages/templates-argocd"    _root/home/grape/templates-argocd
  tar czf "${LAYER}" -C _root .
)

# --- Assemble & push ---
echo "==> Appending overlay to ${BASE_IMAGE}..."
crane append \
  --base "${BASE_IMAGE}" \
  --new_layer "${LAYER}" \
  --platform linux/amd64 \
  -t "${ECR_URI}:${TAG}"

echo "==> Setting entrypoint & env..."
crane mutate "${ECR_URI}:${TAG}" \
  --user "0" \
  --workdir "/home/grape" \
  --entrypoint "/usr/local/bin/grape" \
  --cmd "worker,start" \
  --env "PATH=/usr/local/bin:/usr/bin:/bin" \
  --env "HOME=/home/grape" \
  -t "${ECR_URI}:${TAG}"

echo "==> Tagging as :latest..."
crane tag "${ECR_URI}:${TAG}" latest

echo "==> Forcing new Fargate deployment..."
aws ecs update-service \
  --cluster "${ECS_CLUSTER}" \
  --service "${ECS_SERVICE}" \
  --force-new-deployment \
  --region "${AWS_REGION}" \
  --no-cli-pager

echo "==> Done. Fargate will roll to the new image."
