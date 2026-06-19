# 01 — User Flow (MVP)

## Core Idea

The platform runs ONE cloud-hosted runner (Fargate) that provisions infrastructure for ALL users. Users never deploy their own runners. They connect their AWS account, configure what they want, and click harvest. The runner does the rest.

## The Happy Path

```
User signs up on Trellis
    │
    ▼
Connect AWS account             ← Providers page: deploy CloudFormation in their account
    │                              creates cross-account IAM role → paste Role ARN
    │                              stored in cloud_identities table
    ▼
Create configuration (Vine)     ← Configure page: project name, region, environment,
    │                              VPC, data services, GitOps repos, etc.
    │                              stored in configurations table
    ▼
Harvest                         ← Click "Provision" or run `alethia harvest`
    │                              creates provision_jobs entry (QUEUED)
    │                              links to cloud_identity_id + config_snapshot
    ▼
Runner claims job               ← Cloud-hosted runner polls every 10s
    │                              gets job + cloud_identity (role_arn, external_id)
    │                              calls STS AssumeRole into user's account
    ▼
Provisioning runs               ← Terraform (VPC, EKS, RDS, etc.)
    │                              Git (clone templates, bootstrap repos)
    │                              Helm (ArgoCD install)
    │                              kubectl (ArgoCD manifests)
    ▼
Logs stream in real time        ← job_logs table → Supabase Realtime → Trellis log viewer
    │
    ▼
Infrastructure ready            ← User has EKS + ArgoCD + GitOps in their AWS account
```

## Step-by-Step Detail

### 1. Sign Up / Login

User creates account on Trellis (Supabase Auth). From CLI: `alethia login`.

### 2. Connect AWS Account

**Trellis UI:** Dashboard → Providers → Connect AWS

1. Trellis generates a unique **External ID** (UUID) for this user
2. Trellis creates an unverified `cloud_identities` record
3. User downloads the CloudFormation template (`alethia-bootstrap.yaml`) or uses the AWS Console link
4. User deploys the stack in their AWS account with:
   - **Alethia Account ID:** `787587782604` (trusted principal)
   - **External ID:** the UUID from step 1
5. CloudFormation creates IAM role: `AlethiaProvisionerRole-{ExternalID}` with AdministratorAccess
6. User copies the **Role ARN** from CloudFormation Outputs
7. User pastes Role ARN into Trellis → Trellis validates format, extracts account ID, marks identity as `is_verified=true`

**What's already built:** The entire Providers page, CloudFormation template, and `cloud_identities` table are complete and working.

### 3. Create Configuration (Vine)

User configures infrastructure in Trellis:
- Project name, environment (dev/staging/prod), AWS region
- VPC settings (new or existing, CIDR)
- Data services (RDS, ElastiCache, DynamoDB)
- GitOps repositories (infrastructure, ArgoCD services, applications)
- Template versions (branches of template repos)

Saved as a `configurations` row with full JSON payload.

### 4. Harvest (Provision)

User triggers provisioning:
- **Trellis UI:** "Provision" button on the configuration page
- **CLI:** `alethia harvest` (interactive selection of vineyard + vine + cluster)

This creates a `provision_jobs` entry:
```
job_type: "DEPLOY" (or "BOOTSTRAP" for first-time cluster setup)
status: "QUEUED"
vineyard_id: ...
configuration_id: ...
cloud_identity_id: ...  ← links to the user's AWS credentials
config_snapshot: { ... } ← full config frozen at queue time
```

### 5. Runner Claims and Executes

The cloud-hosted runner (running in Alethia's account `787587782604`):

1. Polls `POST /api/jobs/claim` → gets job + `cloud_identity`
2. Calls `STS AssumeRole` with:
   - `RoleArn`: `arn:aws:iam::{user_account}:role/AlethiaProvisionerRole-{external_id}`
   - `ExternalId`: the UUID
   - Gets temporary credentials (1 hour)
3. Sets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` in process env
4. Executes the provisioning (same code as legacy CLI, reimplemented in Go):
   - Create S3 state bucket
   - Clone template repos
   - Generate tfvars from config
   - Terraform init/plan/apply
   - Get kubeconfig
   - Install ArgoCD via Helm
   - Apply ArgoCD manifests
5. Streams logs to Trellis via `POST /api/jobs/{id}/logs`
6. Updates status to `SUCCESS` or `FAILED`
7. Clears assumed credentials

### 6. User Sees Results

- **Log viewer:** Real-time streaming during provisioning
- **Clusters page:** New cluster appears after successful bootstrap
- **AWS Console:** User can see their EKS cluster, VPC, etc.

## What the User Does NOT Need To Do

- Install Terraform
- Install kubectl or Helm
- Run any CLI commands (beyond `alethia harvest` if they prefer CLI)
- Deploy any runner infrastructure
- Manage Docker images
- Deal with Terraform state

## Phase 2 (After MVP): Self-hosted Runners

For users who want:
- Runners in their own account (data sovereignty)
- Custom runner configurations
- Multiple runners for parallelism

This is where `alethia runner register` with automatic Fargate deploy comes in. But it's not the MVP.
