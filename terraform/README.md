# Grape Worker — Fargate Infrastructure

Terraform configuration that deploys the Grape provisioning worker as an AWS Fargate service. The worker polls the Trellis control plane for queued jobs (BOOTSTRAP, DEPLOY, DESTROY), executes them, and streams logs back in real time.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Trellis (Control Plane)                                 │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Supabase                                          │  │
│  │  · workers table         (registry + heartbeat)    │  │
│  │  · provision_jobs table  (QUEUED → SUCCESS/FAILED) │  │
│  │  · job_logs table        (Realtime streaming)      │  │
│  └────────────────────────────────────────────────────┘  │
│              ▲                                            │
│              │  HTTPS (poll every 10s)                    │
│              ▼                                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Fargate Worker                                    │  │
│  │  · Claims jobs atomically (SELECT FOR UPDATE)      │  │
│  │  · Runs Terraform / Helm / kubectl                 │  │
│  │  · Streams log chunks back to Trellis              │  │
│  │  · Heartbeat every 30s                             │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Self-hosted vs Cloud-hosted

| | Self-hosted | Cloud-hosted |
|---|---|---|
| **Where it runs** | In *your* AWS account | In *Grape's* central AWS account |
| **AWS permissions** | Uses the Fargate task role directly (AdministratorAccess in the same account) | Assumes a cross-account IAM role (`GrapeProvisionerRole-*`) into each customer's account via STS |
| **Who registers it** | You — the platform operator | Grape platform team |
| **Use case** | Single-tenant: you provision infrastructure in your own account | Multi-tenant: one worker serves multiple customer accounts |
| **IAM setup** | Task role gets AdministratorAccess | Task role gets `sts:AssumeRole` on `arn:aws:iam::*:role/GrapeProvisionerRole-*`. Each customer deploys `packages/onboarding/aws/grape-bootstrap.yaml` to create the cross-account role. |
| **Cloud identity** | Not used — worker has native permissions | Job includes `cloud_identity_id` → Trellis returns `role_arn` + `external_id` at claim time → worker calls `sts:AssumeRole` before executing |

**For a thesis demo, use `self-hosted`.** It's simpler: one account, one worker, no cross-account IAM.

## Prerequisites

- AWS CLI configured with credentials for the target account
- Terraform >= 1.5
- Docker
- Grape CLI installed (`brew install grape` or build from source)
- Trellis running and accessible (local or deployed)
- Supabase migration `20260520_provision_broker.sql` applied

## Setup — Step by Step

### 1. Apply the Supabase migration

The worker depends on the `workers`, `provision_jobs`, and `job_logs` tables plus the RPC functions (`claim_next_job`, `update_job_status`, `insert_job_log`, `worker_heartbeat`, `recover_stale_jobs`).

```bash
cd apps/trellis
npx supabase db push
```

Verify the tables exist:

```bash
npx supabase db dump --schema public | grep -E 'CREATE TABLE.*workers|provision_jobs|job_logs'
```

### 2. Log in to Grape and register a worker

You need to be authenticated with Trellis first:

```bash
grape login
```

Then register a worker. This calls `POST /api/workers/register` which:
- Generates a 32-byte random token
- Stores a SHA-256 hash of that token in the `workers` table
- Returns the plaintext token **once** — it cannot be recovered

```bash
grape worker register --name my-fargate-worker --mode self-hosted
```

Output:

```
Worker registered successfully!
  Worker ID:    a1b2c3d4-e5f6-...
  Worker Token: 64-char-hex-string

Save these values - the token cannot be recovered.
```

**Save both values.** You'll need them for Terraform.

### 3. Provision the Fargate infrastructure

```bash
cd terraform
```

Create a backend config file for your S3 state bucket:

```bash
cat > backend.hcl <<EOF
bucket  = "your-terraform-state-bucket"
key     = "grape-worker/terraform.tfstate"
region  = "eu-west-1"
encrypt = true
EOF
```

Edit `terraform.tfvars` with real values:

```hcl
project_name   = "grape-worker"
region         = "eu-west-1"
environment    = "dev"
aws_account_id = "787587782604"

worker_mode  = "self-hosted"
worker_id    = "a1b2c3d4-e5f6-..."      # from step 2
worker_token = "64-char-hex-string"       # from step 2
trellis_url  = "https://adp.prod.itgix.eu"

grape_version = "latest"
vpc_id        = "vpc-0abc123..."          # existing VPC with internet access
subnet_ids    = ["subnet-0aaa...", "subnet-0bbb..."]  # public subnets
```

Apply:

```bash
terraform init -backend-config=backend.hcl
terraform plan
terraform apply
```

This creates:
- ECR repository for the Grape Docker image
- ECS Fargate cluster + service + task definition
- IAM execution role (pulls images, reads secrets)
- IAM task role (AdministratorAccess for self-hosted)
- Secrets Manager secret for the worker token
- Security group (outbound-only)
- CloudWatch log group

### 4. Build and push the Docker image to ECR

```bash
# Get the ECR repo URL from Terraform output
ECR_URL=$(terraform output -raw ecr_repository_url)

# Authenticate Docker with ECR
aws ecr get-login-password --region eu-west-1 | docker login --username AWS --password-stdin $ECR_URL

# Build the image (from repo root)
docker build -t grape:latest ../apps/grape/

# Tag and push
docker tag grape:latest $ECR_URL:latest
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

### 6. Verify the worker is running

Check ECS task status:

```bash
aws ecs list-tasks \
  --cluster grape-worker-dev-cluster \
  --service-name grape-worker-dev-service \
  --region eu-west-1
```

Check CloudWatch logs:

```bash
aws logs tail /ecs/grape-worker-dev --follow --region eu-west-1
```

You should see:

```
Worker started (id=a1b2c3d4-..., mode=self-hosted)
Polling https://adp.prod.itgix.eu for jobs...
```

### 7. Test the full loop

From the CLI:

```bash
# Queue a bootstrap job
grape bootstrap --queue

# Or queue a deploy job
grape harvest
```

From the Trellis dashboard:
- Go to Workers page — your worker should show as ONLINE
- Create a configuration and trigger provisioning
- Watch the log viewer for real-time streaming

## What happens during a job

1. **User** creates a job (via CLI or Trellis UI) → `provision_jobs` row with status `QUEUED`
2. **Worker** polls `POST /api/jobs/claim` every 10 seconds
3. **Supabase RPC** `claim_next_job()` atomically assigns the oldest queued job (uses `SELECT FOR UPDATE SKIP LOCKED` to prevent double-claims)
4. **Worker** updates status to `PROCESSING`, starts executing:
   - **BOOTSTRAP**: Terraform → VPC + EKS, then Helm → ArgoCD
   - **DEPLOY**: Clone repos → Terraform apply → Helm install → ArgoCD manifests
   - **DESTROY**: Terraform destroy → cleanup
5. **Logs** stream via `POST /api/jobs/{id}/logs` → `job_logs` table → Supabase Realtime → Trellis log viewer
6. **Worker** sets final status (`SUCCESS` or `FAILED`)
7. **Stale recovery**: If a worker dies, `recover_stale_jobs()` resets orphaned jobs to `QUEUED` after 15 minutes with no heartbeat

## Updating the worker

```bash
# Build new image
docker build -t grape:latest apps/grape/

# Push to ECR
ECR_URL=$(cd terraform && terraform output -raw ecr_repository_url)
docker tag grape:latest $ECR_URL:latest
docker push $ECR_URL:latest

# Force ECS to pull the new image
aws ecs update-service \
  --cluster grape-worker-dev-cluster \
  --service grape-worker-dev-service \
  --force-new-deployment \
  --region eu-west-1
```

## Teardown

```bash
cd terraform
terraform destroy
```

This removes all Fargate resources, the ECR repository, Secrets Manager secret, and IAM roles. It does **not** touch Supabase tables or the worker registration (those live in the database).
