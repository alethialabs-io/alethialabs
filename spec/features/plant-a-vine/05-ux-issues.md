# UX Issues — Updated for New Architecture

## Resolved by New Schema

| Issue | Old Problem | New Solution |
|-------|------------|-------------|
| Template repos empty → worker crashes | Form didn't populate `env_template_repo` | `vine_repositories` table has `DEFAULT` values |
| Git tokens stored as plaintext | `gitops_argocd_token` in configurations | `vine_git_credentials` with OAuth/secret refs |
| No multi-instance support | One RDS, one Redis, flat table | `vine_databases`, `vine_caches` are 1:N |
| SQS/SNS as YAML textarea | `ses_queues_topics` raw YAML string | `vine_queues`, `vine_topics` tables with structured rows |
| EKS admins as YAML | `eks_cluster_admins` raw YAML string | `vine_eks.cluster_admins` as JSONB array |
| No per-component status | All-or-nothing `status` on configurations | Each component table has `status` + `status_message` |
| No cost estimation | Hardcoded sidebar numbers | `estimated_monthly_cost` per component via Infracost |

## Resolved by Worker Caching

| Issue | Old Problem | New Solution |
|-------|------------|-------------|
| Region selector is static | Hardcoded list of 15 regions | Cached from `EC2 DescribeRegions` on CONNECTION_TEST |
| VPC selector was broken | LIST_VPCS job type didn't exist | Cached from `EC2 DescribeVpcs` on CONNECTION_TEST |
| DNS zone was manual text input | Users type zone ID by hand (error-prone) | Cached from `Route53 ListHostedZones`, shown as dropdown |
| Redis CIDR was manual text | Users type CIDR blocks | Can select from cached VPC/subnet CIDRs |

## Remaining UX Issues

### 1. Repos stacked vertically wastes space

With full-width layout, repositories should be in a 2-column grid: environment repo + GitOps repo side by side.

### 2. Repos load slowly

RepositorySelector fetches provider repos on mount. May re-fetch on every render. Needs investigation — should fetch once and cache.

### 3. Database section needs richer config

Currently just min/max ACU sliders. Users want:
- Engine selection (PostgreSQL, MySQL)
- Engine version dropdown
- Backup retention slider
- IAM auth toggle

All these columns exist in `vine_databases` — just need form UI.

### 4. EKS admin "path" field is confusing

The IAM path input (`/`, `/users/`) confuses users. Either:
- Remove it (default to `/`)
- Add a tooltip explaining what IAM paths are

### 5. No bulk operations

Can't duplicate a vine, can't clone components from one vine to another. Post-MVP.

### 6. No validation of AWS resource names

Project names, queue names, topic names etc. must follow AWS naming rules (alphanumeric + hyphens, max lengths). The form should validate these before submission, not fail at Terraform time.

### 7. Cost sidebar needs debouncing

If calling Infracost API on every form change, rapid edits will flood the API. Debounce 500ms after last change.

## Architecture Decision: AWS Data Source

AWS resource selectors (regions, VPCs, subnets, hosted zones) read from cached data fetched during CONNECTION_TEST.

**Cache location:** The CONNECTION_TEST job's `execution_metadata.cached_resources` field.

**Refresh:** User can click "Refresh" on the AWS connection to re-run CONNECTION_TEST, which re-caches all resources.

**Trade-off:** Data may be stale (user creates a VPC in AWS Console, it won't show until refresh). Acceptable for MVP — better than live calls that are slow and require AWS SDK in Trellis.
