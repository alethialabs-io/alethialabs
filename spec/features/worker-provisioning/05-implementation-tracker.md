# 05 — Implementation Tracker (MVP)

## MVP Scope

ONE cloud-hosted worker in Grape's AWS account (`787587782604`) serves all users. Users connect AWS via CloudFormation, configure infrastructure in Trellis, and harvest. The worker provisions into their accounts via cross-account IAM roles.

## Status Legend

- [x] Done
- [~] Partially done / needs changes
- [ ] Not started

---

## Backend (Supabase)

- [x] `cloud_identities` table with RLS
- [x] `workers` table with RLS
- [x] `provision_jobs` table with RLS
- [x] `job_logs` table with Realtime enabled
- [x] `claim_next_job()` RPC (atomic job claiming)
- [x] `update_job_status()` RPC
- [x] `insert_job_log()` RPC
- [x] `worker_heartbeat()` RPC
- [x] `recover_stale_jobs()` RPC
- [ ] Cron trigger for `recover_stale_jobs()` (pg_cron or Edge Function)

## Trellis UI

- [x] Providers page (AWS connect flow)
- [x] CloudFormation template download + Role ARN input
- [x] `cloud_identities` CRUD
- [x] Configuration form (create/edit Vines)
- [x] Workers dashboard page
- [x] Register Worker sheet (UI)
- [x] Log viewer with Realtime streaming
- [x] Job claim API (`POST /api/jobs/claim`)
- [x] Job status API (`PUT /api/jobs/[id]/status`)
- [x] Job logs API (`POST /api/jobs/[id]/logs`)
- [x] Worker heartbeat API
- [ ] "Provision" button on configuration page that queues a job
- [ ] Job detail view (click job → full log viewer)
- [ ] Auto-queue DEPLOY job when configuration has cloud_identity (partially done in createConfiguration)

## Grape Worker (Go)

- [x] Worker poll loop (`worker/worker.go`)
- [x] Worker API client (`worker/api.go`)
- [x] Job logger with buffered streaming (`worker/logger.go`)
- [x] AWS role assumption (`worker/credentials.go`)
- [x] Bootstrap provisioner (`provisioner/bootstrap.go`)
- [x] Deploy provisioner (`provisioner/deploy.go`)
- [x] Destroy provisioner (`provisioner/destroy.go`)
- [x] Dockerfile (multi-stage, all tools)

## Grape CLI

- [x] `grape login` / `grape logout`
- [x] `grape harvest` (queues DEPLOY job)
- [x] `grape bootstrap --queue` (queues BOOTSTRAP job)
- [x] `grape worker register` (DB registration via CLI)
- [x] `grape worker start` (starts poll loop)

## Infrastructure — Central Worker Deployment

- [x] Terraform for Fargate (`terraform/` — ecs, iam, networking, secrets, logging, ecr)
- [x] CloudFormation template for cross-account role (`packages/onboarding/aws/grape-bootstrap.yaml`)
- [x] Terraform version of cross-account role (`packages/onboarding/aws/grape-bootstrap.tf`)
- [ ] **Deploy the central worker** — `terraform apply` in Grape's account
- [ ] **Build + push Docker image** to ECR
- [ ] **Register central worker** in Trellis (mode=cloud-hosted)
- [ ] **Verify heartbeat** — worker shows ONLINE

## E2E Verification

- [ ] AWS connection: user deploys CloudFormation, pastes Role ARN, identity verified
- [ ] Job queuing: user creates config → provisions → job QUEUED
- [ ] Job claiming: worker claims job, assumes role into user's account
- [ ] Provisioning: Terraform runs in user's account, infrastructure created
- [ ] Log streaming: logs appear in Trellis log viewer in real time
- [ ] Job completion: status → SUCCESS, infrastructure accessible

---

## Priority Order

### Phase 1: Get the central worker running (MVP)
1. Deploy central Fargate worker in account `787587782604`
2. Register it as cloud-hosted in Trellis
3. Test AWS connection flow end-to-end (CloudFormation → Role ARN → verified)
4. Test job queuing → claiming → role assumption → provisioning
5. Test log streaming

### Phase 2: Polish the Trellis UI
6. Add "Provision" button that queues jobs from the configuration page
7. Add job detail view with full log viewer
8. Worker health monitoring in dashboard

### Phase 3: Self-hosted workers (post-MVP)
9. `grape worker register` with automatic Fargate deploy
10. `grape worker destroy`
11. `grape worker status` / `grape worker list`
