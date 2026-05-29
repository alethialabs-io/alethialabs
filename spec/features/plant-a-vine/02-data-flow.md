# Data Flow — Form → Component Tables → Worker → Terraform

## 1. Form Submission

```
User clicks "Plant Vine"
  ↓
Form validation (Zod, per-section)
  ↓
Build CreateVineInput from form sections:
  vine:         { project_name, environment_stage, aws_region, vineyard_id, cloud_identity_id }
  vpc:          { provision_vpc, vpc_id, vpc_cidr, single_nat_gateway }
  eks:          { cluster_version, enable_karpenter, cluster_admins, instance_types, node sizes }
  dns:          { enabled, hosted_zone_id, domain_name, acm, waf }
  repositories: { template repos (defaults), destination repos }
  databases:    [{ name, engine, min/max capacity, ... }]  ← 0 to N
  caches:       [{ name, engine, node_type, ... }]         ← 0 to N
  queues:       [{ name, fifo, visibility_timeout }]       ← 0 to N
  topics:       [{ name, subscriptions }]                  ← 0 to N
  ↓
createVine(input) server action
```

## 2. Server Action — createVine

Location: `app/server/actions/vines.ts`

```
1. Get authenticated user
2. Insert into vines table → get vine.id
3. Insert singleton components (vine_vpc, vine_eks, vine_dns, vine_repositories)
   - All in parallel via Promise.all
   - If any fails → delete vine (CASCADE cleans up)
4. Insert multi-instance components (vine_databases, vine_caches, vine_queues, vine_topics)
   - Each as a batch insert
5. Write audit log entry (CREATED)
6. Return { vine }
7. Redirect to vineyard page or vines list
```

## 3. Provisioning — provisionVine

```
User clicks "Provision" on vine detail
  ↓
provisionVine(vineId) server action
  ↓
1. Read vine from vines table
2. Read all component tables (1:1 via maybeSingle, 1:N via select)
3. Build config_snapshot with backward-compat field names:
   - Flat fields for Go provisioner (create_vpc, vpc_cidr, enable_karpenter, etc.)
   - Nested arrays for 1:N components (databases[], caches[], queues[], topics[])
4. Get verified cloud_identity
5. Insert provision_jobs entry (QUEUED) with config_snapshot + cloud_identity_id
6. Set vine status to QUEUED
7. Write audit log entry (PROVISIONED)
8. Return { jobId }
```

## 4. Worker Execution

```
Worker polls POST /api/jobs/claim
  ↓
Gets job + cloud_identity (role_arn, external_id)
  ↓
STS AssumeRole into user's AWS account
  ↓
Parse config_snapshot → Configuration Go struct
  ↓
RunDeploy:
  1. Create S3 state bucket
  2. Extract embedded templates (packages/templates/)
  3. Generate terraform.tfvars.json from config_snapshot
  4. Terraform init → plan → apply
  5. Parse outputs (cluster endpoint, RDS endpoint, etc.)
  6. Configure kubectl
  7. Install ArgoCD via Helm
  8. Apply ArgoCD manifests
  ↓
Stream logs via POST /api/jobs/{id}/logs
  ↓
Update job status → SUCCESS or FAILED
```

## 5. Form → DB Table Mapping

| Form Section | Tables Written |
|-------------|---------------|
| Project Basics | `vines` (project_name, environment_stage, vineyard_id) |
| AWS & Network | `vines` (aws_region, cloud_identity_id) + `vine_vpc` |
| Platform & EKS | `vine_eks` |
| Repositories | `vine_repositories` |
| Database | `vine_databases` (1 row per database) |
| Caching | `vine_caches` (1 row per cache) |
| Messaging | `vine_queues` + `vine_topics` (1 row per queue/topic) |
| DNS & Security | `vine_dns` |
| Git Auth | `vine_git_credentials` |

## 6. AWS Resource Selectors

Selectors for regions, VPCs, subnets, and Route53 zones read from **cached data**, not live AWS calls.

When the user connects their AWS account (CONNECTION_TEST), the worker fetches and caches:
- Enabled regions
- VPCs per region
- Subnets per VPC
- Route53 hosted zones

This data is stored in the CONNECTION_TEST job's `execution_metadata.cached_resources`. The form reads it from there (or from a dedicated cache table if we add one).
