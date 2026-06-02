# CLI Reference — Grape

Grape is the command-line interface for Trellis. It handles authentication, infrastructure configuration, provisioning, teardown, and worker management. Built in Go with Charmbracelet's `huh` library for interactive TUI forms.

---

## Installation

```bash
brew tap bobikenobi12/bb-thesis-2026 https://github.com/bobikenobi12/bb-thesis-2026
brew install grape
```

---

## Command Tree (Shipped)

```
grape
├── login                     Device code auth with Trellis
├── logout                    Clear local auth token
│
├── config
│   ├── create                Interactive 6-step TUI wizard
│   ├── list                  Table of all configurations
│   ├── get [name]            Fetch config by project name
│   └── pull [name]           Export config YAML locally
│
├── vineyard
│   ├── create [name]         Create workspace (interactive cloud identity selector)
│   ├── list                  Table of vineyards with vine counts
│   └── delete [id]           Delete vineyard with confirmation prompt
│
├── harvest                   Queue a DEPLOY job (interactive vineyard → vine → cluster selection)
├── provision                 Alias for harvest
├── bootstrap                 First-time cluster setup: VPC + K8s + ArgoCD (supports --queue)
├── destroy                   Tear down bootstrapped environment with confirmation
│
├── clusters
│   └── list                  Table of bootstrapped clusters
│
└── worker
    ├── register              Register worker with Trellis (saves token locally)
    └── start                 Start worker poll loop (self-hosted or cloud-hosted mode)
```

---

## Key Workflows

### Quick Start

```bash
# Install and authenticate
brew install grape
grape login

# Create a workspace and configure infrastructure
grape vineyard create "my-project"
grape config create

# Deploy
grape harvest
```

### Full Lifecycle

```bash
# Authenticate
grape login

# Create workspace
grape vineyard create "production"

# Design infrastructure (6-step interactive TUI)
#   Step 1: Select vineyard + basics (name, environment, region)
#   Step 2: Platform selection (EKS/GKE/AKS, instance types, autoscaling)
#   Step 3: Git repositories (infra repo, app repo)
#   Step 4: Network + advanced (VPC CIDR, NAT gateway, DNS)
#   Step 5: Data services (databases, caches, queues)
#   Step 6: Review + submit
grape config create

# Preview what will be provisioned
grape config get my-vine-name

# Deploy to cloud
grape harvest

# When done, tear down cleanly
grape destroy
```

### Worker Setup

```bash
# Register a worker with Trellis (gets worker ID + token)
grape worker register --name "prod-worker" --mode cloud-hosted

# Start the worker daemon
# Polls Trellis every 10s for jobs, sends heartbeat every 30s
grape worker start
```

### CLI Authentication Flow

```bash
# grape login triggers device code flow:
# 1. CLI requests device code from Trellis
# 2. User opens browser to /cli/login?device_code=XXX&verification_code=YYY
# 3. User approves in browser
# 4. CLI receives refresh token via /api/auth/cli/exchange
# 5. Token stored in ~/.config/grape/auth.json
grape login

# Clear stored credentials
grape logout
```

---

## Interactive TUI Details

Grape uses Charmbracelet's `huh` library for rich terminal forms. Key interactions:

### `grape config create` — 6-Step Wizard

| Step | Fields | Notes |
|------|--------|-------|
| 1. Vineyard & Basics | Vineyard selector, project name, environment (dev/staging/prod), region | Region list is provider-specific |
| 2. Platform | Cloud provider, K8s version, instance types, min/desired/max nodes | Supports Karpenter (AWS), Autopilot (GCP) |
| 3. Repositories | Git provider, infra repo, app repo | Fetches repos from connected Git provider |
| 4. Network & Advanced | VPC CIDR, NAT gateway mode, DNS zone, domain | Can use existing VPC |
| 5. Data Services | Databases (engine, version, size), caches, queues | Multi-item arrays |
| 6. Review | Summary table, confirm or go back | Shows estimated cost |

### `grape harvest` — Interactive Selection

```
? Select a vineyard:
  > production (3 vines)
    staging (1 vine)
    development (2 vines)

? Select a vine:
  > api-backend (us-east-1, ACTIVE)
    web-frontend (eu-west-1, DRAFT)

? Select a worker:
  > prod-worker (ONLINE, us-east-1)
    self-hosted (ONLINE, local)
```

---

## Envisioned Commands

These commands map Trellis web features to the CLI. They are not yet implemented but represent the natural CLI evolution.

### Monitoring & Visibility

| Command | Maps from (Trellis) | Purpose |
|---------|---------------------|---------|
| `grape plan [vine-name]` | Terraform plan viewer | Run terraform plan and show resource diff without applying |
| `grape cost [vine-name]` | Cost sidebar | Show monthly cost breakdown by component |
| `grape status [vine-name]` | Vine detail page | Per-component provisioning status (network: ACTIVE, cluster: PROVISIONING, ...) |
| `grape logs [job-id]` | Job log viewer | Stream real-time job logs to terminal |

### Worker Management

| Command | Maps from (Trellis) | Purpose |
|---------|---------------------|---------|
| `grape worker list` | Workers dashboard | List all registered workers with status |
| `grape worker status` | Workers dashboard | Show health, uptime, active jobs for a specific worker |
| `grape worker destroy` | Worker management | Tear down cloud-hosted worker infrastructure |

### Integrations

| Command | Maps from (Trellis) | Purpose |
|---------|---------------------|---------|
| `grape integrations list` | Integrations page | Show connected cloud + git providers with status |

---

## Code Examples for Landing Page

### Hero Terminal Snippet

```bash
$ brew install grape
$ grape login
  ✓ Opening browser for authentication...
  ✓ Authenticated as borislav@tovr.eu

$ grape config create
  ┌─────────────────────────────────────┐
  │  Plant a Vine — Step 1 of 6        │
  │                                     │
  │  Vineyard:    production            │
  │  Project:     api-backend           │
  │  Environment: production            │
  │  Region:      eu-west-1             │
  │  Provider:    AWS                   │
  └─────────────────────────────────────┘
```

### Multi-Cloud Example

```bash
# Same CLI, any cloud
$ grape config create --provider aws    # EKS + Aurora + ElastiCache
$ grape config create --provider gcp    # GKE + Cloud SQL + Memorystore
$ grape config create --provider azure  # AKS + Azure DB + Azure Cache
```

### Deployment Flow

```bash
$ grape harvest
  ? Select vineyard: production
  ? Select vine: api-backend (eu-west-1)
  ? Select worker: prod-worker (ONLINE)

  ✓ Job queued: DEPLOY #42
  ✓ Worker claimed job
  ► Terraform init...
  ► Terraform plan: 47 resources to create
  ► Terraform apply...
  ✓ EKS cluster "api-backend" is ready
  ✓ ArgoCD installed and synced
  ✓ Deployment complete in 12m 34s
```

---

## Configuration Files

| File | Location | Purpose |
|------|----------|---------|
| Auth token | `~/.config/grape/auth.json` | Trellis refresh token from `grape login` |
| Worker credentials | `~/.config/grape/worker.json` | Worker ID + token from `grape worker register` |
| Workspace state | `~/.grape/workspaces/{vineyard}-{env}/` | Local Terraform state and tfvars |
