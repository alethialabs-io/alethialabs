# 06 — E2E Test Plan (MVP)

## Prerequisites

- [x] Postgres with the `20260520_provision_broker.sql` migration applied
- [x] Alethia deployed and accessible
- [ ] Central runner deployed in Alethia's account (787587782604) via `terraform apply`
- [ ] Central runner registered as cloud-hosted in Alethia
- [ ] A separate AWS account to act as the "user's account" (or use the same account for testing)

---

## Test 1: AWS Connection

**Goal:** Verify a user can connect their AWS account via CloudFormation.

1. Log in to Alethia
2. Go to Dashboard → Providers
3. Click "Connect" on AWS
4. Copy the **External ID** shown
5. Click the CloudFormation console link (or download the template)
6. Deploy the stack in the test AWS account:
   - `AlethiaAccountId`: `787587782604`
   - `ExternalId`: paste from step 4
7. Copy the **Role ARN** from CloudFormation Outputs
8. Paste Role ARN into Alethia
9. Click Save

**Verify:**
- `cloud_identities` row has `is_verified=true`
- `credentials` JSONB contains `role_arn`, `external_id`, `account_id`
- Providers page shows AWS as "Connected"

## Test 2: Runner Health

**Goal:** Verify the central runner is running and healthy.

1. Go to Dashboard → Runners
2. Central runner should show as **ONLINE**
3. Last heartbeat should be < 1 minute ago
4. Mode should be "cloud-hosted"

**If OFFLINE:**
- Check ECS task status: `aws ecs list-tasks --cluster alethia-runner-dev-cluster --region eu-west-1`
- Check CloudWatch logs: `aws logs tail /ecs/alethia-runner-dev --follow --region eu-west-1`

## Test 3: Job Queuing

**Goal:** Verify a job gets created when provisioning is triggered.

1. Create a Zone (if none exists)
2. Create a Configuration (Spec):
   - Project name: `e2e-test`
   - Region: `eu-west-1`
   - Environment: `dev`
   - Cloud Identity: select the connected AWS identity
3. Trigger provisioning (via Alethia UI or `alethia spec apply`)
4. Go to Runners page → Recent Jobs

**Verify:**
- Job appears with type `DEPLOY` and status `QUEUED`
- `cloud_identity_id` is set on the job
- `config_snapshot` contains the full configuration

## Test 4: Job Claim + Role Assumption

**Goal:** Verify the runner claims the job and assumes the cross-account role.

1. Watch CloudWatch logs for the central runner
2. Within 10 seconds, the runner should log:
   ```
   Claimed job {id} (type=DEPLOY)
   Assuming role arn:aws:iam::{account}:role/AlethiaProvisionerRole-{ext_id} into account {account}...
   ```
3. Job status should transition: `QUEUED` → `CLAIMED` → `PROCESSING`

**If role assumption fails:**
- Check the CloudFormation stack in the user's account — is the role created?
- Check the External ID matches between `cloud_identities` and the role's trust policy
- Check the Alethia account ID in the trust policy matches `787587782604`

## Test 5: Log Streaming

**Goal:** Verify provisioning logs stream to Alethia in real time.

1. While the job is `PROCESSING`, open the log viewer in Alethia
2. Logs should appear within 2-3 seconds of being written
3. Look for key milestones:
   - `Initializing Terraform...`
   - `Creating S3 state bucket...`
   - `Cloning template repositories...`
   - `Running terraform plan...`
   - `Running terraform apply...` (this takes 15-20 minutes for a full bootstrap)
   - `Configuring kubectl...`
   - `Installing ArgoCD...`
4. STDOUT in normal text, STDERR in red

## Test 6: Provisioning Completion

**Goal:** Verify infrastructure is created in the user's AWS account.

1. Wait for job status to reach `SUCCESS` (or `FAILED`)
2. If `SUCCESS`:
   - Check user's AWS account for: VPC, EKS cluster, RDS, S3 state bucket
   - Verify Clusters page in Alethia shows the new cluster
   - Verify ArgoCD is accessible (if DNS is configured)
3. If `FAILED`:
   - Check error message on the job
   - Check full logs in log viewer
   - Common failures: insufficient IAM permissions, resource limits, template errors

## Test 7: Runner Recovery

**Goal:** Verify stale job recovery when the runner dies.

1. Queue a job
2. Wait for it to be `CLAIMED`
3. Stop the ECS task: `aws ecs stop-task --cluster alethia-runner-dev-cluster --task {arn}`
4. Wait for ECS to auto-restart the task (~60 seconds)
5. Wait 15 minutes for `recover_stale_jobs()` to fire
6. Job should reset to `QUEUED` and get re-claimed by the restarted runner

## Test 8: Error Case — Disconnected AWS

**Goal:** Verify graceful handling when AWS connection is invalid.

1. Create a configuration with a cloud identity
2. Delete the IAM role from the user's AWS account (or change the External ID)
3. Queue a deploy
4. Runner claims job, attempts `AssumeRole` → fails
5. Job status should be `FAILED` with error: "Failed to assume role..."
6. Error should be visible in Alethia job logs

## Test 9: Full Loop — The Money Test

**Goal:** Start from a fresh user, end with working infrastructure.

1. Sign up on Alethia (new account)
2. Connect AWS (deploy CloudFormation, paste Role ARN)
3. Create a Zone
4. Create a Configuration (choose project, region, VPC, services)
5. Click Provision
6. Watch logs stream in real time
7. Wait for SUCCESS (~15-20 minutes for bootstrap)
8. Verify: EKS cluster running, ArgoCD accessible, GitOps repos bootstrapped
9. Clean up: trigger DESTROY job

**This is the demo flow for the thesis.**
