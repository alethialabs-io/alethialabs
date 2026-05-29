# Template Variable Mapping — New Schema

102 Terraform variables in `packages/templates/variables.tf`. Each now maps to a specific component table.

## Legend

- **TABLE** = Stored in a component table, user configures via form
- **DEFAULT** = Has a default in Terraform or the component table, not exposed in form
- **HARDCODED** = Set to a fixed value in the config_snapshot generation
- **MISSING** = Variable exists in Terraform but has no corresponding table column yet

---

## Core Identity → `vines` table

| Variable | Column | Notes |
|----------|--------|-------|
| `project_name` | `project_name` | |
| `environment` | `environment_stage` | Enum: development, staging, production |
| `region` | `aws_region` | |
| `aws_account_id` | `aws_account_id` | Derived from cloud_identity |

## VPC / Networking → `vine_vpc` table

| Variable | Column | Status |
|----------|--------|--------|
| `provision_vpc` | `provision_vpc` | TABLE |
| `vpc_cidr` | `vpc_cidr` | TABLE |
| `vpc_id` | `vpc_id` | TABLE (existing VPC) |
| `vpc_single_nat_gateway` | `single_nat_gateway` | TABLE |
| `vpc_private_subnet_ids` | — | MISSING (needed for existing VPC) |
| `vpc_public_subnet_ids` | — | MISSING |
| `vpc_private_route_table_ids` | — | MISSING |

## EKS Cluster → `vine_eks` table

| Variable | Column | Status |
|----------|--------|--------|
| `provision_eks` | — | HARDCODED true |
| `eks_cluster_version` | `cluster_version` | TABLE |
| `enable_karpenter` | `enable_karpenter` | TABLE |
| `eks_aws_auth_users` | `cluster_admins` | TABLE (JSONB) |
| `eks_instance_types` | `instance_types` | TABLE (TEXT[]) |
| `eks_ng_min_size` | `node_min_size` | TABLE |
| `eks_ng_max_size` | `node_max_size` | TABLE |
| `eks_ng_desired_size` | `node_desired_size` | TABLE |
| `eks_ami_type` | — | DEFAULT (AL2_x86_64) |
| `eks_disk_size` | — | DEFAULT (50) |
| `eks_volume_type` | — | DEFAULT (gp3) |
| `eks_ng_capacity_type` | — | DEFAULT (SPOT) |
| `addons_versions` | — | MISSING |
| `eks_kms_key_users` | — | MISSING |
| `cluster_endpoint_public_access_cidrs` | — | MISSING |

## Database → `vine_databases` table (1:N)

| Variable | Column | Status |
|----------|--------|--------|
| `create_rds` | — | Derived: `EXISTS(vine_databases)` |
| `rds_scaling_config.min_capacity` | `min_capacity` | TABLE |
| `rds_scaling_config.max_capacity` | `max_capacity` | TABLE |
| `rds_config.engine` | `engine` | TABLE |
| `rds_config.engine_version` | `engine_version` | TABLE |
| `rds_config.db_port` | `port` | TABLE |
| `rds_iam_auth_enabled` | `iam_auth` | TABLE |
| `rds_backup_retention_period` | `backup_retention_days` | TABLE |
| `rds_default_username` | — | DEFAULT (postgres) |
| `rds_extra_credentials` | — | MISSING |
| `rds_allowed_cidr_blocks` | — | MISSING |

## Cache → `vine_caches` table (1:N)

| Variable | Column | Status |
|----------|--------|--------|
| `create_elasticache_redis` | — | Derived: `EXISTS(vine_caches)` |
| `redis_instance_type` | `node_type` | TABLE |
| `redis_cluster_size` | `num_cache_nodes` | TABLE |
| `redis_multi_az_enabled` | `multi_az` | TABLE |
| `redis_allowed_cidr_blocks` | `allowed_cidr_blocks` | TABLE (TEXT[]) |
| `redis_engine_version` | — | DEFAULT |
| `redis_family` | — | DEFAULT |
| `redis_cluster_mode_enabled` | — | DEFAULT |
| `redis_automatic_failover_enabled` | — | DEFAULT |

## SQS / SNS → `vine_queues` + `vine_topics` tables (1:N)

| Variable | Column | Status |
|----------|--------|--------|
| `provision_sqs` | — | Derived: `EXISTS(vine_queues) OR EXISTS(vine_topics)` |
| `sqs_queues` | `vine_queues` rows | TABLE — each row is a queue |
| `sns_topics` | `vine_topics` rows | TABLE — each row is a topic |

## DNS / ACM → `vine_dns` table

| Variable | Column | Status |
|----------|--------|--------|
| `acm_certificate_enable` | `acm_certificate` | TABLE |
| `dns_hosted_zone` | `hosted_zone_id` | TABLE (read-only from AWS) |
| `dns_main_domain` | `domain_name` | TABLE |
| `cloudfront_waf_enabled` | `cloudfront_waf` | TABLE |
| `application_waf_enabled` | `application_waf` | TABLE |

## ECR → `vine_ecr_repos` table (1:N)

| Variable | Column | Status |
|----------|--------|--------|
| `provision_ecr` | — | Derived: `EXISTS(vine_ecr_repos)` |
| `ecr_repository_name` | `name` | TABLE |
| `ecr_repository_image_tag_mutability` | `image_tag_mutability` | TABLE (enum) |
| `ecr_repository_image_scan_on_push` | `scan_on_push` | TABLE |

## Repositories → `vine_repositories` table

| Variable | Source | Status |
|----------|--------|--------|
| `env_template_repo` | `env_template_repo` | TABLE (default: itgix standard) |
| `env_template_repo_branch` | `env_template_branch` | TABLE (default: v1.2.7) |
| `gitops_template_repo` | `gitops_template_repo` | TABLE (default: itgix argoinfrasvcs) |
| `gitops_template_repo_branch` | `gitops_template_branch` | TABLE (default: v1.2.11) |

## Summary — New vs Old

| Category | Total Vars | In Component Table | Default | Missing |
|----------|-----------|-------------------|---------|---------|
| Core | 4 | 4 | 0 | 0 |
| VPC | 7 | 4 | 0 | 3 |
| EKS | 16 | 8 | 4 | 4 |
| RDS | 12 | 7 | 1 | 4 |
| Cache | 11 | 5 | 4 | 2 |
| SQS/SNS | 6 | 4 | 0 | 2 |
| DNS/WAF | 5 | 5 | 0 | 0 |
| ECR | 10 | 3 | 0 | 7 |
| Repos | 4 | 4 | 0 | 0 |
| **Total** | **75** | **44** | **9** | **22** |

**44 out of 75 key variables are now in component tables** (up from 18 in the old schema). The remaining 22 MISSING variables are advanced configs with sensible Terraform defaults — they can be added as columns to the component tables later without schema changes.
