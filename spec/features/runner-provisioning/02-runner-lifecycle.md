# 02 — Runner Lifecycle

## States

```
REGISTERED → DEPLOYING → ONLINE ⇄ OFFLINE → DRAINING → DEREGISTERED
```

| State | Meaning |
|-------|---------|
| REGISTERED | DB entry created, no infrastructure yet |
| DEPLOYING | Terraform/Docker in progress (during `alethia runner register`) |
| ONLINE | Heartbeat received within last 5 minutes |
| OFFLINE | No heartbeat for 5+ minutes |
| DRAINING | Runner finishing current job, won't claim new ones |
| DEREGISTERED | Runner and infrastructure torn down |

## Registration

1. CLI calls `POST /api/runners/register` with name + mode
2. Alethia generates 32-byte random token, stores SHA-256 hash
3. Returns plaintext token **once** — cannot be recovered
4. Runner row created in `runners` table with status `OFFLINE`

## Deployment (Fargate)

After registration, the CLI deploys infrastructure:

1. **Workspace**: `~/.alethia/workspaces/runner-{name}/`
2. **Extract embedded Terraform** (from `internal/assets/terraform/runner/`)
3. **Generate tfvars.json** with: runner_id, runner_token, vpc_id, subnet_ids, region, mode, alethia_url, aws_account_id
4. **S3 state bucket**: `alethia-runner-{name}-{region}-tfstate` (created if not exists)
5. **Terraform init** with S3 backend
6. **Terraform plan + apply** → creates: ECR, ECS cluster, ECS service, task definition, IAM roles, Secrets Manager, security group, CloudWatch log group
7. **Docker build** → build Alethia image from `apps/cli/`
8. **ECR push** → authenticate with ECR, tag + push
9. **Force deploy** → `aws ecs update-service --force-new-deployment`
10. **Wait for health** → poll ECS task status, then check Alethia for heartbeat

## Heartbeat

- Runner sends heartbeat every **30 seconds** via `POST /api/runners/heartbeat`
- Alethia updates `last_heartbeat` timestamp and sets status to `ONLINE`
- A runner is considered `OFFLINE` if `last_heartbeat` > 5 minutes ago

## Job Execution

1. Runner polls `POST /api/jobs/claim` every **10 seconds**
2. Supabase RPC `claim_next_job()` atomically assigns the oldest `QUEUED` job
   - Uses `SELECT FOR UPDATE SKIP LOCKED` to prevent double-claims
   - For cloud-hosted: filters by `cloud_identity_id`
3. Runner updates status to `PROCESSING`
4. Executes: BOOTSTRAP, DEPLOY, or DESTROY via provisioner functions
5. Logs streamed via `POST /api/jobs/{id}/logs` → `job_logs` table → Supabase Realtime
6. Final status: `SUCCESS` or `FAILED` with error message

## Stale Job Recovery

The `recover_stale_jobs()` RPC handles orphaned jobs:
- Runs periodically (should be called by a Supabase cron or from the Alethia backend)
- Resets jobs to `QUEUED` if:
  - Status is `CLAIMED` or `PROCESSING`
  - `claimed_at` > 15 minutes ago
  - Runner has no heartbeat in the last 5 minutes (or runner_id is NULL)

## Teardown

```bash
alethia runner destroy --name my-runner
```

1. Confirm with user (dangerous operation)
2. Run `terraform destroy` in the runner workspace
3. Delete runner row from Alethia (or mark as DEREGISTERED)
4. Clean up workspace directory

## Infrastructure Created per Runner

| Resource | Name Pattern | Purpose |
|----------|-------------|---------|
| ECR Repository | `alethia-runner-{env}-alethia` | Docker image storage |
| ECS Cluster | `alethia-runner-{env}-cluster` | Fargate cluster |
| ECS Service | `alethia-runner-{env}-service` | Keeps task running |
| ECS Task Definition | `alethia-runner-{env}-task` | Container spec (1 vCPU, 4 GB) |
| IAM Execution Role | `alethia-runner-{env}-exec` | Pulls images, reads secrets |
| IAM Task Role | `alethia-runner-{env}-task` | AdministratorAccess (self-hosted) |
| Secrets Manager | `alethia-runner-{env}-runner-token` | Runner auth token |
| Security Group | `alethia-runner-{env}-sg` | Outbound-only |
| CloudWatch Log Group | `/ecs/alethia-runner-{env}` | Container logs (30 day retention) |
| S3 Bucket | `alethia-runner-{name}-{region}-tfstate` | Terraform state |
