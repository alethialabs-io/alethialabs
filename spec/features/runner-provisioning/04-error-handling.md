# 04 — Error Handling & Monitoring

## Preflight Errors (during `alethia runner register`)

| Check | Error | Recovery |
|-------|-------|----------|
| AWS credentials missing | `No AWS credentials found. Configure with: aws configure` | User runs aws configure or sets env vars |
| AWS credentials expired | `AWS credentials expired. Re-authenticate with: aws sso login` | User refreshes SSO/MFA |
| Wrong AWS account | `Connected to account {id}. Expected {id}.` (if specified) | User switches profile |
| Docker not running | `Docker daemon not running. Start Docker Desktop or: sudo systemctl start docker` | User starts Docker |
| Docker not installed | `Docker not found in PATH. Install from: https://docs.docker.com/get-docker/` | User installs Docker |
| Terraform not installed | `Terraform not found. The CLI will download it automatically.` | Auto-download via hc-install (existing pattern) |
| Terraform wrong version | `Terraform {version} found, need >= 1.5. Upgrading...` | Auto-download correct version |
| Trellis unreachable | `Cannot reach Trellis at {url}. Check your network or ALETHIA_WEB_ORIGIN.` | User checks URL/network |
| Not authenticated | `Not logged in. Run: alethia login` | User runs alethia login |

## Deployment Errors (during Terraform/Docker)

| Phase | Error | Recovery |
|-------|-------|----------|
| ECR push fails | `Failed to push image: {error}. Retrying...` | Auto-retry 3 times with backoff |
| Terraform plan fails | `Terraform plan failed: {error}` | Print full error, suggest checking AWS permissions |
| Terraform apply fails | `Terraform apply failed: {error}. Resources may have been partially created.` | Print `alethia runner destroy --name {name}` for cleanup |
| ECS task won't start | `ECS task failed to start after 5 minutes. Check CloudWatch logs: aws logs tail {log_group}` | Print log tail command |
| No heartbeat after deploy | `Runner deployed but no heartbeat received after 2 minutes. Possible causes: ...` | Print checklist (network, Trellis URL, token) |

## Runtime Errors (runner running in Fargate)

### Runner Goes Offline

**Detection:** Trellis checks `last_heartbeat` on runners table.

**Causes:**
1. ECS task crashed (OOM, process exit)
2. Network issue (can't reach Trellis)
3. Fargate capacity issue

**Recovery:**
- ECS service auto-restarts crashed tasks (deployment config: min 100%, max 200%)
- Runner re-enters poll loop on restart, sends heartbeat immediately
- Stale jobs auto-recovered by `recover_stale_jobs()` RPC after 15 minutes

**User-visible:**
- Trellis Runners page shows status `OFFLINE` with last heartbeat time
- Jobs stuck in `CLAIMED`/`PROCESSING` get reset to `QUEUED` after 15 minutes
- Future: push notification to user when runner goes offline

### Job Fails

**Detection:** Runner catches error, sets job status to `FAILED` with error message.

**Causes:**
1. Terraform apply error (insufficient permissions, resource limits, invalid config)
2. Git clone failure (bad credentials, repo not found)
3. Helm install failure (chart errors, cluster unreachable)
4. Timeout (job runs too long)

**Recovery:**
- Error message stored in `provision_jobs.error_message`
- Full error logs in `job_logs` table (streamed in real time)
- User can inspect logs in Trellis log viewer, fix config, re-queue

**What we do NOT auto-retry:**
- Terraform apply failures (could leave partial state)
- Permission errors (won't fix themselves)

**What we COULD auto-retry (future):**
- Transient network errors
- AWS API throttling (429s)

### Runner Dies Mid-Job

**Detection:** `recover_stale_jobs()` RPC.

**Behavior:**
1. Job stays `CLAIMED` or `PROCESSING`
2. Runner's heartbeat stops
3. After 15 minutes, `recover_stale_jobs()` resets the job to `QUEUED`
4. Another runner (or the restarted same runner) picks it up

**Risk:** Terraform state might be inconsistent if the runner died mid-apply. The re-run will attempt to reconcile via Terraform's state file (stored in S3).

## Monitoring

### What Trellis Shows

**Runners page:**
- Runner name, mode, status (ONLINE/OFFLINE/DRAINING), last heartbeat, created date
- Visual indicator: green dot for ONLINE, grey for OFFLINE, yellow for DRAINING

**Jobs table:**
- Job type, status (QUEUED/CLAIMED/PROCESSING/SUCCESS/FAILED), runner, created, completed
- Click to open log viewer

**Log viewer:**
- Real-time log streaming via Supabase Realtime
- STDOUT in normal text, STDERR in red
- Line numbers and timestamps

### What CloudWatch Shows

- Container stdout/stderr (same as log viewer, but persisted 30 days)
- ECS task events (start, stop, crash, restart)
- Useful for debugging runner-level issues (vs job-level issues in Trellis)

### Future: Health Alerts

- Trellis detects runner OFFLINE for > 10 minutes → email/notification
- Job stuck in PROCESSING for > 30 minutes → alert
- Job failure rate > 50% in last hour → alert
