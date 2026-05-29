# Page Architecture — Plant a Vine

## Page Layout

```
/dashboard/configure
├── Page header ("Plant a Vine" + subtitle)
└── Form (full width, no max-width — fills dashboard content area)
    ├── Section 1: Project Basics
    ├── Section 2: AWS & Network
    ├── Section 3: Platform & Versions
    ├── Section 4: Repositories & GitOps
    ├── Section 5: Database
    ├── Section 6: Advanced
    └── Submit button
```

No wrapping Card around the entire form. Each section is its own Card. Full-width layout — the dashboard sidebar already constrains the content area.

---

## Section 1: Project Basics

A Card containing:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `vineyard_id` | VineyardSelector (existing) | No | Workspace grouping. Has inline "create new" |
| `project_name` | Text input, max 25 chars | Yes | Validates: required, max=25 |
| `environment_stage` | Combobox with presets | Yes | Presets: development, staging, production. User can type custom value |

**environment_stage UX:** Use a Combobox (shadcn `Popover` + `Command`) that shows presets as suggestions but accepts any typed value. Not a locked `Select`.

---

## Section 2: AWS & Network

A Card containing:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `cloud_identity_id` | Select dropdown | Yes | Lists verified entries from `cloud_identities` table. Shows account name + ID. Links to /dashboard/integrations if empty |
| `aws_region` | Grouped Select | Yes | Same region groups as current form. Auto-derived account_id is stored as `aws_account_id` on submit |
| VPC mode | Segmented toggle | Yes | "Create New VPC" (default) vs "Use Existing VPC" |
| `vpc_cidr` | Text input (font-mono) | Conditional | Shown when "Create New". Default: 10.0.0.0/16 |
| `selected_vpc_id` | Select dropdown | Conditional | Shown when "Use Existing". Fetches VPCs from AWS. See VPC Listing below |
| `enable_dns` | Switch toggle | No | Toggles DNS sub-fields |
| `dns_hosted_zone` | Text input | Conditional | Route 53 hosted zone ID |
| `dns_domain_name` | Text input | Conditional | Domain name |

### VPC Listing

**MVP approach:** Skip the worker job queue. Instead, create a lightweight Trellis API route (`/api/aws/vpcs`) that:
1. Reads the user's cloud_identity (role_arn, external_id)
2. Calls AWS STS AssumeRole from the Trellis server
3. Calls EC2 DescribeVpcs with the temporary credentials
4. Returns VPC list

This requires `@aws-sdk/client-sts` and `@aws-sdk/client-ec2` as dependencies. The Trellis deployment needs an IAM identity that can call STS AssumeRole (environment variable `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` or an instance role).

**If AWS SDK is not feasible in Trellis deployment**, fall back to create-new-only with a disabled "Use Existing" option and a tooltip: "Connect via grape CLI to use existing VPCs."

---

## Section 3: Platform & Versions

A Card containing:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `container_platform` | 3-card selector (existing) | Yes | Standard / AI Workloads / Custom. When preset selected, show "Templates auto-configured" callout |
| `eks_version` | Select with badges | Yes | Default: 1.32. Each option shows Standard (green badge) or Extended Support — 6x cost (amber badge). Recommended badge on latest |
| `terraform_version` | Select | Yes | Options: 1.11.4 (Latest), 1.10.5, 1.9.8. Default: 1.11.4 |

### EKS Version Data

Static array, update manually when AWS releases new versions:

```
1.32 — Standard Support (Recommended)
1.31 — Standard Support
1.30 — Standard Support
1.29 — Extended Support ($0.60/hr vs $0.10/hr)
1.28 — Extended Support
```

### Container Platform → Template Auto-Assignment

When platform is "standard" or "ai-workloads", auto-assign on form submission:
- **Standard:** `git@github.com:itgix/adp-k8s-templ-argoinfrasvcs.git` branch `v1.2.7`
- **AI:** `git@github.com:itgix/adp-k8s-aitempl-argoinfra.git` branch `v1.2.3-ai`
- **Custom:** User selects all repos manually

Display the auto-assigned template repo as a read-only info block within the Repositories section, not here.

---

## Section 4: Repositories & GitOps

A Card containing:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `env_git_repo` | RepositorySelector (existing) | Yes | Environment Git repository |
| `gitops_destination_repo` | RepositorySelector (existing) | Yes | GitOps destination repo |
| Template info | Read-only block | — | Shows auto-assigned template when platform != "custom" |
| `applications_template_repo` | RepositorySelector | Conditional | Only shown when platform = "custom" |
| `applications_destination_repo` | RepositorySelector | Conditional | Only shown when platform = "custom" |
| ArgoCD Git Auth | Provider selector OR manual token | Yes | See ArgoCD Auth below |
| `enable_gitops_destination` | Switch toggle | No | Toggles app token sub-section |
| `gitops_app_token` | Manual password input | Conditional | Only manual entry for app token (simpler) |

### ArgoCD Git Authentication

The ArgoCD token is a Git provider PAT used by ArgoCD to pull from repositories. Instead of manual entry:

1. Show a Select dropdown listing linked Git providers from `provider_tokens` table
2. Display as: `GitHub (@username)` / `GitLab (@username)` etc.
3. Store the selected provider slug in form state as `argocd_git_provider`
4. On form submission, the server action resolves `argocd_git_provider` → actual `access_token` from `provider_tokens` and stores it in `gitops_arcocd_token`
5. Fallback: "Enter token manually" toggle shows a password input

For the app token (secondary), only support manual entry — no provider selector. This avoids the broken double-selector issue.

---

## Section 5: Database

A Card with toggle in the header:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `create_rds` | Switch in card header | No | Default: true. Toggles card content |
| `db_min_capacity` | Number input (0.5–128, step 0.5) | Conditional | Default: 2 |
| `db_max_capacity` | Number input (0.5–128, step 0.5) | Conditional | Default: 16 |

---

## Section 6: Advanced

A Card containing:

### EKS Cluster Admins

Structured row input — **NOT round-tripped through YAML**.

State management:
- Component owns `useState<EksAdmin[]>` with the actual structured data
- Initialize from existing YAML if editing, otherwise empty
- Add button appends `{ username: "", path: "/" }` to the array — row appears immediately
- User fills in the username
- On form submit, serialize to YAML string for `eks_cluster_admins` field

Each row: `[email input] [path input, default "/"] [X remove button]`
Bottom: `[+ Add Admin]`

### SES Queues & Topics

Same pattern — component owns structured state, no YAML round-trip.

**Queues:** rows of `[name input] [visibility_timeout number input] [X]`
**Topics:** rows of `[name input] [subscriptions comma input] [X]`

### Feature Toggles

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `enable_karpenter` | Switch | true | Kubernetes node auto-scaling |
| `enable_cloudfront_waf` | Switch | false | Web Application Firewall |
| `enable_redis` | Switch | false | ElastiCache Redis |
| `redis_allowed_cidr_blocks` | Tag input | — | Shown when Redis enabled. Multi-value CIDR tags with Enter to add, X to remove |

---

## Form State Architecture

**Key principle:** Structured data lives in component state. YAML serialization happens only at submit time.

```
Component state (structured)
  ↓ user interaction (instant)
Re-render with updated rows
  ↓ form.handleSubmit
Serialize structured data → YAML strings
  ↓
Server action (createConfiguration)
  ↓ resolve argocd_git_provider → access_token
  ↓ resolve cloud_identity_id → aws_account_id
Insert into configurations table
  ↓ if vineyard_id + cloud_identity_id set
Create provision_job (QUEUED)
```

**Form type:** Extend `PublicConfigurationsInsert` with:
- `argocd_git_provider?: string` — selected provider slug for token resolution
- `selected_vpc_id?: string` — for existing VPC selection (needs DB column)
- `eks_version?: string` — EKS version (needs DB column)

---

## Removed Fields

| Field | Reason |
|-------|--------|
| `aws_account_id` | Derived from `cloud_identity_id` at submit time |
| `cluster_id` | Legacy Tendril model, no longer used |
| Cluster selector component | Legacy Tendril model |
| `gitops_arcocd_token` password input | Replaced by provider selector |
| YAML textareas for eks_cluster_admins | Replaced by structured row input |
| YAML textarea for ses_queues_topics | Replaced by structured row input |
| Terraform versions 1.3.9–1.8.5 | Obsolete |
