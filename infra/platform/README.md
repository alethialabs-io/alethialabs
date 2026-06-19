# Alethia Runner — Fargate Infrastructure

Terraform configuration that deploys the node provisioning runner as an AWS Fargate service. The runner polls the Alethia control plane for queued jobs (BOOTSTRAP, DEPLOY, DESTROY), executes them, and streams logs back in real time.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Alethia (Control Plane)                                 │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Postgres (Drizzle)                                │  │
│  │  · runners table         (registry + heartbeat)    │  │
│  │  · jobs table            (QUEUED → SUCCESS/FAILED) │  │
│  │  · job_logs table        (LISTEN/NOTIFY streaming) │  │
│  └────────────────────────────────────────────────────┘  │
│              ▲                                            │
│              │  HTTPS (poll every 10s)                    │
│              ▼                                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Fargate Runner                                    │  │
│  │  · Claims jobs atomically (SELECT FOR UPDATE)      │  │
│  │  · Runs Terraform / Helm / kubectl                 │  │
│  │  · Streams log chunks back to Alethia              │  │
│  │  · Heartbeat every 30s                             │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Self-hosted vs Cloud-hosted

| | Self-hosted | Cloud-hosted |
|---|---|---|
| **Where it runs** | In *your* AWS account | In *Alethia's* central AWS account |
| **AWS permissions** | Uses the Fargate task role directly (AdministratorAccess in the same account) | Assumes a cross-account IAM role (`AlethiaProvisionerRole-*`) into each customer's account via STS |
| **Who registers it** | You — the platform operator | Alethia platform team |
| **Use case** | Single-tenant: you provision infrastructure in your own account | Multi-tenant: one runner serves multiple customer accounts |
| **IAM setup** | Task role gets AdministratorAccess | Task role gets `sts:AssumeRole` on `arn:aws:iam::*:role/AlethiaProvisionerRole-*`. Each customer deploys `infra/connector/aws/alethia-bootstrap.yaml` to create the cross-account role. |
| **Cloud identity** | Not used — runner has native permissions | Job includes `cloud_identity_id` → Alethia returns `role_arn` + `external_id` at claim time → runner calls `sts:AssumeRole` before executing |

**For a thesis demo, use `self-hosted`.** It's simpler: one account, one runner, no cross-account IAM.

## Prerequisites

- AWS CLI configured with credentials for the target account
- Terraform >= 1.10
- Docker
- Alethia CLI installed (`brew install alethia` or build from source)
- Alethia running and accessible (local or deployed) with its database migrated

## Setup — Step by Step

### 1. Ensure the console database is migrated

The runner depends on the `runners`, `jobs`, and `job_logs` tables plus the RPC functions
(`claim_next_job`, `update_job_status`, `insert_job_log`, `runner_heartbeat`, `recover_stale_jobs`).
These are Drizzle-managed and applied by the console's `migrate` step (the compose `migrate` one-shot
/ `scripts/migrate.mjs`) — no separate migration to run here. Confirm the console booted cleanly
against its `ALETHIA_DATABASE_URL`.

### 2. Log in to Alethia and register a runner

You need to be authenticated with Alethia first:

```bash
alethia login
```

Then register a runner. This calls `POST /api/cli/runners/register` which:
- Generates a 32-byte random token
- Stores a SHA-256 hash of that token in the `runners` table
- Returns the plaintext token **once** — it cannot be recovered

```bash
alethia runner register --name my-fargate-runner --mode self-hosted
```

Output:

```
Runner registered successfully!
  Runner ID:    a1b2c3d4-e5f6-...
  Runner Token: 64-char-hex-string

Save these values - the token cannot be recovered.
```

**Save both values.** You'll need them for Terraform.

### 3. Provision the Fargate infrastructure

```bash
cd terraform
```

Create a backend config for your S3-compatible storage (SeaweedFS / Garage / MinIO / S3 / R2):

```bash
cp backend.hcl.example backend.hcl
# Edit backend.hcl — set the endpoint + bucket name (create the bucket first)
```

Set the storage credentials as environment variables:

```bash
export AWS_ACCESS_KEY_ID="$ALETHIA_STORAGE_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$ALETHIA_STORAGE_SECRET_ACCESS_KEY"
```

> **Note:** `backend.hcl` is gitignored — it contains credentials. See `backend.hcl.example` for the full template.

Copy and fill in the variables file:

```bash
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with real values (runner_id, runner_token, vpc_id, subnet_ids)
```

> **Note:** `terraform.tfvars` is gitignored — it contains sensitive values like `runner_token`.

Apply:

```bash
terraform init -backend-config=backend.hcl
terraform plan
terraform apply
```

#### Migrating from an existing AWS S3 backend

If you previously used an AWS S3 bucket for state:

```bash
# 1. Back up current state
terraform state pull > terraform.tfstate.backup

# 2. Create the new backend.hcl with your S3-compatible config
cp backend.hcl.example backend.hcl

# 3. Set storage credentials and migrate
export AWS_ACCESS_KEY_ID="$ALETHIA_STORAGE_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$ALETHIA_STORAGE_SECRET_ACCESS_KEY"
terraform init -migrate-state -backend-config=backend.hcl

# 4. Verify
terraform state list
```

This creates:
- ECR repository for the Alethia Docker image
- ECS Fargate cluster + service + task definition
- IAM execution role (pulls images, reads secrets)
- IAM task role (AdministratorAccess for self-hosted)
- Secrets Manager secret for the runner token
- Security group (outbound-only)
- CloudWatch log group

### 4. Build and push the Docker image to ECR

```bash
# Get the ECR repo URL from Terraform output
ECR_URL=$(terraform output -raw ecr_repository_url)

# Authenticate Docker with ECR
aws ecr get-login-password --region eu-west-1 | docker login --username AWS --password-stdin $ECR_URL

# Build the image (from repo root)
docker build -t alethia:latest ../apps/cli/

# Tag and push
docker tag alethia:latest $ECR_URL:latest
docker push $ECR_URL:latest
```

### 5. Force a new deployment (first time or after pushing a new image)

ECS won't pull the new image automatically if the tag is the same (`latest`). Force a new deployment:

```bash
aws ecs update-service \
  --cluster $(terraform output -raw cluster_arn | xargs basename) \
  --service $(terraform output -raw service_name) \
  --force-new-deployment \
  --region eu-west-1
```

### 6. Verify the runner is running

Check ECS task status:

```bash
aws ecs list-tasks \
  --cluster runner-dev-runner-cluster \
  --service-name runner-dev-runner-service \
  --region eu-west-1
```

Check CloudWatch logs:

```bash
aws logs tail /ecs/runner-dev-runner --follow --region eu-west-1
```

You should see:

```
Runner started (id=a1b2c3d4-..., mode=self-hosted)
Polling https://adp.prod.itgix.eu for jobs...
```

### 7. Test the full loop

From the CLI:

```bash
# Queue a bootstrap job
alethia bootstrap --queue

# Or queue a deploy job
alethia harvest
```

From the Alethia dashboard:
- Go to Runners page — your runner should show as ONLINE
- Create a configuration and trigger provisioning
- Watch the log viewer for real-time streaming

## What happens during a job

1. **User** creates a job (via CLI or Alethia UI) → `jobs` row with status `QUEUED`
2. **Runner** polls `POST /api/jobs/claim` every 10 seconds
3. **Postgres RPC** `claim_next_job()` atomically assigns the oldest queued job (uses `SELECT FOR UPDATE SKIP LOCKED` to prevent double-claims)
4. **Runner** updates status to `PROCESSING`, starts executing:
   - **BOOTSTRAP**: Terraform → VPC + EKS, then Helm → ArgoCD
   - **DEPLOY**: Clone repos → Terraform apply → Helm install → ArgoCD manifests
   - **DESTROY**: Terraform destroy → cleanup
5. **Logs** stream via `POST /api/jobs/{id}/logs` → `job_logs` table → Postgres LISTEN/NOTIFY → SSE → Alethia log viewer
6. **Runner** sets final status (`SUCCESS` or `FAILED`)
7. **Stale recovery**: If a runner dies, `recover_stale_jobs()` resets orphaned jobs to `QUEUED` after 15 minutes with no heartbeat

## Updating the runner

```bash
# Build new image
docker build -t alethia:latest apps/cli/

# Push to ECR
ECR_URL=$(cd terraform && terraform output -raw ecr_repository_url)
docker tag alethia:latest $ECR_URL:latest
docker push $ECR_URL:latest

# Force ECS to pull the new image
aws ecs update-service \
  --cluster runner-dev-runner-cluster \
  --service runner-dev-runner-service \
  --force-new-deployment \
  --region eu-west-1
```

## Teardown

```bash
cd terraform
terraform destroy
```

This removes all Fargate resources, the ECR repository, Secrets Manager secret, and IAM roles. It does **not** touch the database tables or the runner registration (those live in Postgres).
