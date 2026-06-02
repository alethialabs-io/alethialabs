# Feature Inventory

Complete matrix of what Trellis ships today, what's in progress, and what's planned. Every feature claim in the landing page and pitch deck must trace back to an entry here.

**Status legend**: SHIPPED | IN-PROGRESS | PLANNED | DEPRECATED

---

## Infrastructure Configuration (Trellis Web)

| Feature | Status | Evidence |
|---------|--------|----------|
| Multi-cloud provider support (AWS / GCP / Azure) | SHIPPED | `lib/cloud-providers/registry.ts`, onboarding components for all three |
| "Plant a Vine" 11-section form | SHIPPED | `components/plant-vine/section-*.tsx` (project basics, network, cluster, databases, caches, NoSQL, messaging, DNS, secrets, container registry, repositories) |
| Real-time cost estimation sidebar | SHIPPED | `components/plant-vine/cost-sidebar.tsx` — fetches region pricing, sums per-resource costs |
| Cloud identity onboarding (all 3 providers) | SHIPPED | `components/onboarding/aws-connection.tsx`, `gcp-connection.tsx`, `azure-connection.tsx` |
| Provider-specific service name mapping | SHIPPED | `lib/cloud-providers/` — EKS/GKE/AKS, VPC/VNet, Route53/CloudDNS/AzureDNS, etc. |
| Normalized vine schema (12 component tables) | SHIPPED | `vine_network`, `vine_cluster`, `vine_database`, `vine_caches`, `vine_topics`, `vine_queues`, `vine_dns`, `vine_nosql_tables`, `vine_secrets`, `vine_container_registries` |
| Multi-provider Git integration | SHIPPED | GitHub, GitLab, Bitbucket OAuth via `provider_tokens` table |
| Integrations dashboard with connection status | SHIPPED | `components/integrations/` |
| Provider ribbon (switch AWS/GCP/Azure in form) | SHIPPED | `components/plant-vine/provider-ribbon.tsx` |
| Cloud identity selector (per-provider account picker) | SHIPPED | `components/plant-vine/cloud-identity-selector.tsx` |
| Vine duplication (quick copy + duplicate & edit) | SHIPPED | `components/vine-detail/duplicate-modal.tsx` |
| Infracost API integration (accurate cost breakdown) | IN-PROGRESS | Spec complete (`spec/features/vine-schema-redesign/06-infracost-integration.md`), worker-side integration exists |

### Infrastructure services supported per cloud

| Service | AWS | GCP | Azure |
|---------|-----|-----|-------|
| Container orchestration | EKS | GKE | AKS |
| Networking | VPC | VPC Network | VNet |
| Relational database | Aurora | Cloud SQL | Azure Database |
| Cache | ElastiCache | Memorystore | Azure Cache for Redis |
| NoSQL | DynamoDB | Firestore | Cosmos DB |
| DNS | Route 53 | Cloud DNS | Azure DNS |
| Messaging (queues) | SQS | Pub/Sub | Service Bus |
| Messaging (topics) | SNS | Pub/Sub | Service Bus |
| Container registry | ECR | Artifact Registry | ACR |
| Secrets | Secrets Manager | Secret Manager | Key Vault |
| WAF | CloudFront WAF | Cloud Armor | Azure WAF |
| Certificates | ACM | Managed Certificate | App Service Cert |

---

## CLI (Grape)

| Command | Status | Evidence |
|---------|--------|----------|
| `grape login` / `grape logout` | SHIPPED | `cmd/login.go`, `cmd/logout.go` — device code auth flow |
| `grape config create` (6-step interactive TUI) | SHIPPED | `cmd/config_create.go` — Charmbracelet/huh forms |
| `grape config list` | SHIPPED | `cmd/config_list.go` |
| `grape config get` | SHIPPED | `cmd/config_get.go` |
| `grape config pull` | SHIPPED | `cmd/config_pull.go` |
| `grape vineyard create [name]` | SHIPPED | `cmd/vineyard_create.go` |
| `grape vineyard list` | SHIPPED | `cmd/vineyard_list.go` |
| `grape vineyard delete` | SHIPPED | `cmd/vineyard_delete.go` |
| `grape harvest` (queue DEPLOY job) | SHIPPED | `cmd/harvest.go` — interactive vineyard/vine/cluster selection |
| `grape provision` (alias for harvest) | SHIPPED | `cmd/provision.go` |
| `grape bootstrap` (VPC + K8s + ArgoCD) | SHIPPED | `cmd/bootstrap.go` — supports `--queue` for remote worker |
| `grape destroy` | SHIPPED | `cmd/destroy.go` |
| `grape clusters list` | SHIPPED | `cmd/clusters_list.go` |
| `grape worker register` | SHIPPED | `cmd/worker.go` |
| `grape worker start` | SHIPPED | `cmd/worker.go` — poll loop daemon |
| Homebrew distribution | SHIPPED | `brew tap bobikenobi12/bb-thesis-2026 && brew install grape` |

### Envisioned CLI commands (mapped from Trellis features)

These commands map web features to the terminal but are not yet implemented:

| Command | Maps from | Purpose |
|---------|-----------|---------|
| `grape plan [vine-name]` | Terraform plan viewer | Show plan without applying |
| `grape cost [vine-name]` | Cost sidebar | Show cost breakdown |
| `grape logs [job-id]` | Job log viewer | Stream job logs locally |
| `grape status [vine-name]` | Vine detail page | Per-component provisioning status |
| `grape worker list` | Workers dashboard | List all registered workers |
| `grape worker status` | Workers dashboard | Show worker health |
| `grape worker destroy` | Worker management | Tear down worker infrastructure |
| `grape integrations list` | Integrations page | Show connected providers |

---

## Worker System

| Feature | Status | Evidence |
|---------|--------|----------|
| Cloud-hosted Fargate worker | SHIPPED | `terraform/` (ECS task definition, IAM roles) |
| Self-hosted worker mode | SHIPPED | `worker/worker.go` — mode: `self-hosted` or `cloud-hosted` |
| Job polling + atomic claiming | SHIPPED | `POST /api/jobs/claim` |
| Cross-account IAM role assumption (AWS) | SHIPPED | `worker/credentials.go` — STS AssumeRole |
| Workload Identity Federation (GCP) | SHIPPED | `worker/gcp_credentials.go` — WIF activation |
| Federated identity (Azure) | SHIPPED | `worker/credentials.go` — OIDC token exchange |
| Real-time log streaming | SHIPPED | `worker/logger.go` — batched writes to `POST /api/jobs/{id}/logs` |
| Worker heartbeat (30s interval) | SHIPPED | `worker/worker.go` — stale recovery if missed |
| Job types: CONNECTION_TEST, FETCH_RESOURCES | SHIPPED | Resource discovery for all 3 clouds |
| Job types: BOOTSTRAP, PLAN, DEPLOY, DESTROY | SHIPPED | Full provisioning lifecycle |
| Job types: DEPLOY_WORKER, DESTROY_WORKER | SHIPPED | Worker self-provisioning |

---

## Dashboard & Visualization

| Feature | Status | Evidence |
|---------|--------|----------|
| Overview dashboard (stats, integrations, recent jobs) | SHIPPED | `app/(private)/dashboard/page.tsx` |
| Vineyard management (CRUD, list/detail) | SHIPPED | `app/(private)/dashboard/vineyards/` |
| Vine detail view (per-component infrastructure tab) | SHIPPED | `components/vine-detail/infrastructure-tab.tsx` |
| Job log viewer with Realtime streaming | SHIPPED | `app/(private)/dashboard/jobs/[id]/page.tsx` |
| Workers dashboard (status, heartbeat, add worker) | SHIPPED | `app/(private)/dashboard/workers/page.tsx` |
| Terraform plan viewer with resource tree | SHIPPED | `components/plan/` |
| Vine audit log (action history) | SHIPPED | `vine_audit_log` table |
| Estate Map (React Flow topology) | IN-PROGRESS | Referenced in pitch deck, vineyard estate map component exists |

---

## Security & Auth

| Feature | Status | Evidence |
|---------|--------|----------|
| Zero-credential model (no static cloud keys stored) | SHIPPED | Workers assume roles at runtime |
| Cross-account IAM roles with External ID (AWS) | SHIPPED | CloudFormation template generates `GrapeProvisionerRole` |
| Workload Identity Federation (GCP) | SHIPPED | `components/onboarding/gcp-connection.tsx` |
| Federated Identity with OIDC (Azure) | SHIPPED | `components/onboarding/azure-connection.tsx` |
| Multi-provider OAuth (GitHub, GitLab, Bitbucket, Google) | SHIPPED | Supabase Auth providers |
| Device code auth for CLI | SHIPPED | `grape login` + `/cli/login` page |
| Row-Level Security on all tables | SHIPPED | Supabase RLS policies |
| Credential-scoped cloud identity queries | SHIPPED | All queries filter by `provider` to prevent cross-provider leaks |

---

## Documentation (Vintner)

| Feature | Status | Evidence |
|---------|--------|----------|
| Fumadocs site | SHIPPED | `apps/vintner/` — Fumadocs framework |
| Grape CLI docs (auth, config, deployment) | SHIPPED | `content/docs/grape/*.mdx` |
| Trellis platform docs | SHIPPED | `content/docs/trellis/index.mdx` |
| Tendril agent docs | SHIPPED | `content/docs/tendril/index.mdx` (historical reference) |

---

## Deprecated

| Feature | Status | Notes |
|---------|--------|-------|
| Tendril in-cluster agent | DEPRECATED | Replaced by Grape Worker pull model. Docs retained for historical reference. |
| Legacy CLI (`apps/legacy-cli`) | DEPRECATED | Being migrated to Grape. See `spec/features/grape-legacy-migration/`. |
