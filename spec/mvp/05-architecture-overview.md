# Architecture Overview

## System Topology

```
  Developer Browser                    Developer Terminal
       │                                     │
       ▼                                     ▼
┌──────────────┐                     ┌───────────────┐
│   Trellis    │                     │   Grape CLI   │
│  (Next.js)   │◄────────────────────│   (Go/Cobra)  │
│   Vercel     │     REST API        │   Homebrew    │
└──────┬───────┘                     └───────────────┘
       │
       ▼
┌──────────────┐         poll / log         ┌───────────────┐
│   Supabase   │◄──────────────────────────►│  Grape Worker │
│  PostgreSQL  │    /api/jobs/claim          │  (Go daemon)  │
│  + Realtime  │    /api/jobs/{id}/logs      │  ECS Fargate  │
│  + Auth      │                            └───────┬───────┘
│  + RLS       │                                    │
└──────────────┘                                    │
                              AssumeRole / WIF / FederatedID
                                                    │
                                                    ▼
                                     ┌─────────────────────────┐
                                     │   User's Cloud Account  │
                                     │   AWS  │  GCP  │  Azure │
                                     ├─────────────────────────┤
                                     │  VPC/VNet               │
                                     │  EKS/GKE/AKS           │
                                     │  Aurora/CloudSQL/AzDB   │
                                     │  ElastiCache/Memorystore│
                                     │  DynamoDB/Firestore     │
                                     │  SQS/PubSub/ServiceBus  │
                                     │  Route53/CloudDNS       │
                                     │  ArgoCD (installed)     │
                                     └─────────────────────────┘
```

---

## Component Responsibilities

| Component | Language | Role | Deployment |
|-----------|----------|------|------------|
| **Trellis** | TypeScript / Next.js | Web control plane — auth, vineyards, vines, cloud identities, Git tokens, job queue, dashboard UI | Vercel |
| **Grape CLI** | Go / Cobra | Local auth, config creation via interactive TUI, job queuing, legacy local provisioning | Homebrew binary |
| **Grape Worker** | Go | Job claiming, cloud credential assumption, Terraform/Helm/kubectl execution, log streaming back to Trellis | ECS Fargate or self-hosted |
| **Vintner** | TypeScript / Fumadocs | Documentation site with CLI, platform, and agent docs | Vercel |
| **ArgoCD** | — | In-cluster GitOps reconciler, installed automatically during bootstrap | User's K8s cluster |

---

## Security Architecture

### Zero-Credential Model

Trellis never stores static cloud keys. The control plane is decoupled from the execution plane:

```
Traditional:    CI/CD ──(static keys)──► Cloud Account     ← keys leak, keys rotate, keys get over-permissioned
Trellis:        Worker ──(assume role)──► Cloud Account     ← short-lived session, scoped permissions, no keys stored
```

### Per-Provider Authentication

| Provider | Auth Method | How It Works |
|----------|-------------|-------------|
| **AWS** | Cross-account IAM Role | User deploys CloudFormation template that creates `GrapeProvisionerRole` with External ID. Worker calls `STS:AssumeRole` at job execution time. Session expires after 1 hour. |
| **GCP** | Workload Identity Federation | User configures WIF pool + provider. Worker exchanges OIDC token for short-lived GCP credentials. No service account key file. |
| **Azure** | Federated Identity | User creates App Registration with federated credential. Worker authenticates via OIDC token exchange. No client secret. |

### Data Security

- All Supabase tables have Row-Level Security (RLS) policies scoped to `auth.uid()`
- `cloud_identities` queries are always filtered by `provider` to prevent cross-provider data leaks
- Git provider tokens (`provider_tokens`) are stored encrypted at rest in Supabase
- Worker authentication uses unique token per worker, stored in `~/.config/grape/worker.json`
- Device code auth flow for CLI — no password entry in terminal

---

## Data Model

### Core Tables

```
profiles ─────────┐
                   │ user_id
vineyards ────────┤
  │                │
  │ vineyard_id    │
  ▼                │
vines ─────────────┘
  │ vine_id
  ├── vine_network            (1:1)
  ├── vine_cluster            (1:1)
  ├── vine_dns                (1:1)
  ├── vine_database           (1:many)
  ├── vine_caches             (1:many)
  ├── vine_nosql_tables       (1:many)
  ├── vine_queues             (1:many)
  ├── vine_topics             (1:many)
  ├── vine_secrets            (1:many)
  └── vine_container_registries (1:many)
```

### Job Orchestration

```
provision_jobs
  │ job_id
  ├── job_logs          (1:many, streamed chunks)
  ├── config_snapshot   (JSONB — form data at submission time)
  └── execution_metadata (JSONB — worker output, cluster info)

workers
  ├── status: ONLINE | OFFLINE | DRAINING
  └── metadata (JSONB — deploy config, region, image tag)
```

### Supporting Tables

| Table | Purpose |
|-------|---------|
| `cloud_identities` | AWS/GCP/Azure credentials (role ARN, WIF config, federated identity config) + cached resources (VPCs, subnets, zones) |
| `provider_tokens` | Git provider OAuth tokens (GitHub, GitLab, Bitbucket) with refresh logic |
| `integrations` | Third-party service registry (name, auth method, status, docs URL) |
| `cli_logins` | Device code auth flow state (device_code, verification_code, expires_at) |
| `vine_audit_log` | Action history (action, component_type, changes JSONB) |

---

## Tech Stack

### Frontend
| Technology | Purpose |
|-----------|---------|
| Next.js 16 | App router, server actions, API routes |
| React 19 | UI components |
| Tailwind CSS 4 | Styling |
| shadcn/ui + Radix | Component library |
| React Flow | Infrastructure topology visualization |
| React Hook Form + Zod | Form management and validation |
| Zustand | Client-side state management |

### Backend
| Technology | Purpose |
|-----------|---------|
| Supabase | PostgreSQL, Auth, Realtime (WebSockets), Row-Level Security, S3 storage |
| Vercel | Hosting for Trellis and Vintner |

### CLI & Worker
| Technology | Purpose |
|-----------|---------|
| Go 1.25 | CLI binary and worker daemon |
| Cobra | Command routing |
| Charmbracelet (huh, lipgloss, bubbletea) | Interactive TUI forms and styling |
| terraform-exec | Terraform CLI wrapper |
| AWS SDK v2, GCP SDK, Azure SDK | Cloud resource discovery and authentication |
| Helm SDK | Chart installation (ArgoCD) |

### Infrastructure
| Technology | Purpose |
|-----------|---------|
| Terraform | Infrastructure-as-Code generation and execution |
| ArgoCD | In-cluster GitOps reconciliation |
| Helm | Kubernetes package management |
| Docker | Worker container images |
| ECS Fargate | Cloud-hosted worker runtime |

### Integrations
| Technology | Purpose |
|-----------|---------|
| Infracost | Pre-deploy cost estimation |
| GitHub / GitLab / Bitbucket | Git provider OAuth and repository integration |
| AWS / GCP / Azure pricing APIs | Real-time cost sidebar data |

---

## Worker Execution Flow

```
1. Worker starts (grape worker start)
   └── Poll loop every 10s
       └── POST /api/jobs/claim
           ├── No job → sleep 10s → retry
           └── Job claimed → executeJob(job)

2. executeJob(job):
   ├── Read cloud_identity from job config
   ├── Assume credentials:
   │   ├── AWS: STS AssumeRole
   │   ├── GCP: WIF token exchange
   │   └── Azure: Federated identity OIDC
   ├── Switch on job.type:
   │   ├── CONNECTION_TEST → verify auth, list resources
   │   ├── FETCH_RESOURCES → discover VPCs, subnets, zones, IAM
   │   ├── PLAN → terraform plan + infracost analysis
   │   ├── DEPLOY → terraform apply + ArgoCD install
   │   ├── DESTROY → terraform destroy
   │   ├── DEPLOY_WORKER → provision worker infrastructure
   │   └── DESTROY_WORKER → teardown worker infrastructure
   ├── Stream logs → POST /api/jobs/{id}/logs (batched)
   └── Update job status → SUCCESS or FAILED

3. Heartbeat every 30s
   └── POST /api/workers/heartbeat
       └── If missed → Trellis marks worker OFFLINE → stale job recovery
```
