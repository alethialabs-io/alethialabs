# Terraform Golden Template — Bug Fixes & Supabase Backend

Audit and hardening of the `terraform/` golden template that deploys Alethia workers on ECS Fargate.

## Background & Motivation

The golden template is shipped to users as the canonical way to deploy an Alethia worker. A review found a critical IAM bug (container fails to start), plaintext secrets committed to git, and several hardening gaps that make the template unsafe for production use. Additionally, the project already relies on Supabase — using Supabase S3-compatible storage for Terraform state eliminates the AWS S3 dependency.

## Findings

### Critical

| # | File | Issue |
|---|------|-------|
| 1 | `iam.tf:23-37` | Execution role's `execution_secrets` policy only grants `secretsmanager:GetSecretValue` on `worker_token`. The task definition also injects `infracost_key` as a secret. ECS cannot start the container — `AccessDeniedException` at launch. |

### Security

| # | File | Issue |
|---|------|-------|
| 2 | `terraform.tfvars:8` | `worker_token` committed in plaintext to a git-tracked file. Token is visible in git history. |
| 3 | `iam.tf:46-50` | Self-hosted mode attaches `AdministratorAccess` to the task role. Intentional (worker provisions full infrastructure) but should be documented clearly. |

### Hardening

| # | File | Issue |
|---|------|-------|
| 4 | `ecr.tf:3,5` | `image_tag_mutability = "MUTABLE"` + `force_delete = true` — non-reproducible deploys and dangerous `terraform destroy` in production. |
| 5 | `secrets.tf:4,14` | `recovery_window_in_days = 0` on both secrets — accidental deletion is permanent, no recovery window. |
| 6 | `ecs.tf:74` | `assign_public_ip = true` hardcoded — should be parameterized for private-subnet deployments. |
| 7 | `ecs.tf:65-80` | No `deployment_circuit_breaker` — container crash loops are not auto-stopped or rolled back. |
| 8 | `main.tf:11` | `backend "s3" {}` had no state locking. Migrating to Supabase S3 with `use_lockfile = true` addresses this. |

## Fixes Applied

1. Added `infracost_key.arn` to execution role secrets policy
2. Created `terraform.tfvars.example` with placeholder values, gitignored the real file
3. Created `backend.hcl.example` with Supabase S3-compatible configuration
4. Bumped `required_version` to `>= 1.10` for `use_lockfile` support
5. Added variables for `ecr_image_tag_mutability`, `ecr_force_delete`, `secrets_recovery_window_days`, `assign_public_ip`
6. Wired new variables into `ecr.tf`, `secrets.tf`, `ecs.tf`
7. Added `deployment_circuit_breaker` to ECS service
8. Updated README with Supabase backend setup and secrets management guidance
