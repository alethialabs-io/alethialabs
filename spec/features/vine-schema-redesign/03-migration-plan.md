# 03 — Migration Plan

## Strategy: parallel tables, not in-place rename

The old `configurations` table stays untouched while we build the new schema. Once everything works, we deprecate and eventually drop it.

## Phase 1: Create new tables

Apply the migration from `02-new-schema.md`. This creates:
- `vines`
- `vine_vpc`
- `vine_eks`
- `vine_database`
- `vine_redis`
- `vine_dns`
- `vine_repositories`
- `vine_full` view

No data is migrated yet. The old `configurations` table is untouched.

## Phase 2: Migrate existing data

SQL script to copy existing `configurations` rows into the new tables:

```sql
-- For each existing configuration, create entries in the new tables
INSERT INTO vines (id, user_id, vineyard_id, cloud_identity_id, project_name, environment_stage, aws_region, aws_account_id, terraform_version, status, created_at, updated_at)
SELECT id, user_id, vineyard_id, cloud_identity_id, project_name,
  COALESCE(environment_stage, 'development'), COALESCE(aws_region, 'eu-west-1'),
  aws_account_id, COALESCE(terraform_version, '1.11.4'),
  COALESCE(status, 'DRAFT'), created_at, updated_at
FROM configurations;

INSERT INTO vine_vpc (vine_id, provision_vpc, vpc_cidr)
SELECT id, COALESCE(create_vpc, true), COALESCE(vpc_cidr, '10.0.0.0/16')
FROM configurations;

INSERT INTO vine_eks (vine_id, enable_karpenter, cluster_admins)
SELECT id, COALESCE(enable_karpenter, true),
  CASE WHEN eks_cluster_admins IS NOT NULL AND eks_cluster_admins != ''
    THEN ('["' || eks_cluster_admins || '"]')::jsonb
    ELSE '[]'::jsonb
  END
FROM configurations;

INSERT INTO vine_database (vine_id, enabled, min_capacity, max_capacity)
SELECT id, COALESCE(create_rds, true),
  COALESCE(db_min_capacity, 0.5), COALESCE(db_max_capacity, 4)
FROM configurations;

INSERT INTO vine_redis (vine_id, enabled, allowed_cidr_blocks)
SELECT id, COALESCE(enable_redis, false),
  CASE WHEN redis_allowed_cidr_blocks IS NOT NULL AND redis_allowed_cidr_blocks != ''
    THEN string_to_array(redis_allowed_cidr_blocks, ',')
    ELSE '{}'
  END
FROM configurations;

INSERT INTO vine_dns (vine_id, enabled, dns_main_domain, dns_hosted_zone, cloudfront_waf_enabled)
SELECT id, COALESCE(enable_dns, false),
  dns_domain_name, dns_hosted_zone, COALESCE(enable_cloudfront_waf, false)
FROM configurations;

INSERT INTO vine_repositories (vine_id, env_destination_repo, gitops_destination_repo, gitops_argocd_token, apps_destination_repo, apps_token)
SELECT id, env_git_repo, gitops_destination_repo, gitops_argocd_token,
  applications_destination_repo, gitops_app_token
FROM configurations;
```

## Phase 3: Update Trellis server actions

Replace `configurations.ts` CRUD with new functions that write to `vines` + component tables. The config form (being reworked in another instance) writes to the new tables.

Read operations can use the `vine_full` view for backward compat, or query individual tables for component-specific data.

## Phase 4: Update provision job creation

When a user clicks "Provision", the `config_snapshot` in `provision_jobs` should be populated from `vine_full` (the view), so the Go provisioner sees the same flat shape it expects.

## Phase 5: Worker component status updates

The Go provisioner gets updated to call back to Trellis with per-component status updates as it provisions. New API route: `PUT /api/vines/{id}/components/{component}/status`.

## Phase 6: Deprecate old table

Once all reads and writes go through the new tables:
1. Remove all references to the `configurations` table in Trellis code
2. Rename `configurations` to `configurations_deprecated` (keep for safety)
3. After 2 weeks of no issues, drop it

## What NOT to change yet

- **Go provisioner struct** (`types/configuration.go`) — reads from `vine_full` view via config_snapshot, no changes needed initially
- **Terraform variable mapping** (`terraform.go`) — same struct, same mapping
- **Deploy logic** (`deploy.go`) — consumes the same flat struct
