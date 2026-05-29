# 01 — Current State Analysis

## The `configurations` table: 47 columns, one flat row

The current schema puts everything — project metadata, VPC settings, EKS options, RDS config, Git repos, DNS, WAF, Redis, messaging, UI layout coordinates — in a single table.

### Problems

1. **No per-component status** — you can't tell if the VPC was created but EKS failed. It's all-or-nothing.
2. **Unused columns** — 12+ fields are stored but never read by the provisioner (see below).
3. **Missing fields** — the Go struct expects `env_template_repo_branch`, `gitops_template_repo_branch`, `applications_template_repo_branch` but they don't exist in the DB.
4. **Empty repo URLs** — the form doesn't populate template repos, so the provisioner tries to clone `git@:.git` and crashes.
5. **No defaults for templates** — the standard ItGix template repos should be defaults, not empty strings.
6. **Flat = inflexible** — adding a new component means adding more columns to an already bloated table.

### Field inventory by component

#### Actually used by the provisioner (deploy.go + terraform.go)

| Component | Fields | Notes |
|-----------|--------|-------|
| **Identity** | `id`, `user_id`, `project_name`, `environment_stage`, `vineyard_id` | Core identifiers |
| **AWS** | `aws_account_id`, `aws_region` | Region + account for all AWS operations |
| **VPC** | `create_vpc`, `vpc_cidr` | Mapped to `provision_vpc` in tfvars |
| **DNS** | `enable_dns` → `acm_certificate_enable`, `dns_domain_name` → `dns_main_domain`, `dns_hosted_zone` | Field names don't match between DB and Terraform |
| **RDS** | `create_rds` (derived), `db_min_capacity` | `db_max_capacity` is stored but NOT used |
| **Redis** | `enable_redis` → `create_elasticache_redis`, `redis_allowed_cidr_blocks` | |
| **K8s** | `enable_karpenter` | `eks_cluster_admins` is stored but NOT used |
| **WAF** | `enable_cloudfront_waf` → `cloudfront_waf_enabled` | |
| **Git repos** | `env_template_repo`, `env_git_repo`, `gitops_template_repo`, `gitops_destination_repo`, `applications_template_repo`, `applications_destination_repo` | ALL required for deploy but often empty |
| **Git auth** | `gitops_argocd_token`, `gitops_app_token` | Used in Helm ArgoCD config |
| **Terraform** | `terraform_version` | Used to download the right binary |
| **Fallback** | `full_config` | JSON blob that overrides everything — legacy escape hatch |

#### Stored but NEVER read by the provisioner

| Field | Why it exists |
|-------|---------------|
| `container_platform` | UI selection (standard/ai-workloads) — used to pick template repo in the form, not in the provisioner |
| `environment_repository` | Unclear purpose, duplicate of `env_git_repo`? |
| `gitops_repository` | Unclear purpose, duplicate of `gitops_template_repo`? |
| `gitops_app_template` | Never referenced |
| `gitops_destinations_repo` | Duplicate of `gitops_destination_repo` (note the 's') |
| `gitops_infra_destination_repo` | Never referenced |
| `enable_gitops_destination` | Never referenced |
| `db_max_capacity` | Stored but provisioner only reads `db_min_capacity` |
| `eks_cluster_admins` | Stored but provisioner doesn't map it to tfvars |
| `ses_queues_topics` | Never referenced |
| `cluster_id` | FK to clusters, but never used in deploy |
| `description` | Metadata, never used |
| `download_count`, `last_downloaded_at` | Analytics only |
| `ui_position_x`, `ui_position_y` | Canvas layout coordinates |

### Field name mismatches (DB → Terraform)

The provisioner maps DB field names to different Terraform variable names:

| DB column | Terraform variable |
|-----------|-------------------|
| `create_vpc` | `provision_vpc` |
| `enable_dns` | `acm_certificate_enable` |
| `dns_domain_name` | `dns_main_domain` |
| `enable_redis` | `create_elasticache_redis` |
| `enable_cloudfront_waf` | `cloudfront_waf_enabled` |
| `db_min_capacity` | `rds_scaling_config.min_capacity` (nested) |

These mismatches make it hard to reason about the data flow.
