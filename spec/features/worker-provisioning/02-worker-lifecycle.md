# 02 — Worker Lifecycle

## States

```
REGISTERED → DEPLOYING → ONLINE ⇄ OFFLINE → DRAINING → DEREGISTERED
```

| State | Meaning |
|-------|---------|
| REGISTERED | DB entry created, no infrastructure yet |
| DEPLOYING | Terraform/Docker in progress (during `alethia worker register`) |
| ONLINE | Heartbeat received within last 5 minutes |
| OFFLINE | No heartbeat for 5+ minutes |
| DRAINING | Worker finishing current job, won't claim new ones |
| DEREGISTERED | Worker and infrastructure torn down |

## Registration

1. CLI calls `POST /api/workers/register` with name + mode
2. Trellis generates 32-byte random token, stores SHA-256 hash
3. Returns plaintext token **once** — cannot be recovered
4. Worker row created in `workers` table with status `OFFLINE`

## Deployment (Fargate)

After registration, the CLI deploys infrastructure:

1. **Workspace**: `~/.alethia/workspaces/worker-{name}/`
2. **Extract embedded Terraform** (from `internal/assets/terraform/worker/`)
3. **Generate tfvars.json** with: worker_id, worker_token, vpc_id, subnet_ids, region, mode, trellis_url, aws_account_id
4. **S3 state bucket**: `alethia-worker-{name}-{region}-tfstate` (created if not exists)
5. **Terraform init** with S3 backend
6. **Terraform plan + apply** → creates: ECR, ECS cluster, ECS service, task definition, IAM roles, Secrets Manager, security group, CloudWatch log group
7. **Docker build** → build Alethia image from `apps/cli/`
8. **ECR push** → authenticate with ECR, tag + push
9. **Force deploy** → `aws ecs update-service --force-new-deployment`
10. **Wait for health** → poll ECS task status, then check Trellis for heartbeat

## Heartbeat

- Worker sends heartbeat every **30 seconds** via `POST /api/workers/heartbeat`
- Trellis updates `last_heartbeat` timestamp and sets status to `ONLINE`
- A worker is considered `OFFLINE` if `last_heartbeat` > 5 minutes ago

## Job Execution

1. Worker polls `POST /api/jobs/claim` every **10 seconds**
2. Supabase RPC `claim_next_job()` atomically assigns the oldest `QUEUED` job
   - Uses `SELECT FOR UPDATE SKIP LOCKED` to prevent double-claims
   - For cloud-hosted: filters by `cloud_identity_id`
3. Worker updates status to `PROCESSING`
4. Executes: BOOTSTRAP, DEPLOY, or DESTROY via provisioner functions
5. Logs streamed via `POST /api/jobs/{id}/logs` → `job_logs` table → Supabase Realtime
6. Final status: `SUCCESS` or `FAILED` with error message

## Stale Job Recovery

The `recover_stale_jobs()` RPC handles orphaned jobs:
- Runs periodically (should be called by a Supabase cron or from the Trellis backend)
- Resets jobs to `QUEUED` if:
  - Status is `CLAIMED` or `PROCESSING`
  - `claimed_at` > 15 minutes ago
  - Worker has no heartbeat in the last 5 minutes (or worker_id is NULL)

## Teardown

```bash
alethia worker destroy --name my-worker
```

1. Confirm with user (dangerous operation)
2. Run `terraform destroy` in the worker workspace
3. Delete worker row from Trellis (or mark as DEREGISTERED)
4. Clean up workspace directory

## Infrastructure Created per Worker

| Resource | Name Pattern | Purpose |
|----------|-------------|---------|
| ECR Repository | `alethia-worker-{env}-alethia` | Docker image storage |
| ECS Cluster | `alethia-worker-{env}-cluster` | Fargate cluster |
| ECS Service | `alethia-worker-{env}-service` | Keeps task running |
| ECS Task Definition | `alethia-worker-{env}-task` | Container spec (1 vCPU, 4 GB) |
| IAM Execution Role | `alethia-worker-{env}-exec` | Pulls images, reads secrets |
| IAM Task Role | `alethia-worker-{env}-task` | AdministratorAccess (self-hosted) |
| Secrets Manager | `alethia-worker-{env}-worker-token` | Worker auth token |
| Security Group | `alethia-worker-{env}-sg` | Outbound-only |
| CloudWatch Log Group | `/ecs/alethia-worker-{env}` | Container logs (30 day retention) |
| S3 Bucket | `alethia-worker-{name}-{region}-tfstate` | Terraform state |
