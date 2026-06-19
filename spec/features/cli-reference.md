# CLI Reference — Alethia

Alethia is the command-line interface for Alethia. It handles authentication, infrastructure configuration, provisioning, teardown, and runner management. Built in Go with Charmbracelet's `huh` library for interactive TUI forms.

---

## Installation

```bash
brew tap bobikenobi12/bb-thesis-2026 https://github.com/bobikenobi12/bb-thesis-2026
brew install alethia
```

---

## Command Tree (Shipped)

```
alethia
├── login                     Device code auth with Alethia
├── logout                    Clear local auth token
│
├── config
│   ├── create                Interactive 6-step TUI wizard
│   ├── list                  Table of all configurations
│   ├── get [name]            Fetch config by project name
│   └── pull [name]           Export config YAML locally
│
├── zone
│   ├── create [name]         Create workspace (interactive cloud identity selector)
│   ├── list                  Table of zones with spec counts
│   └── delete [id]           Delete zone with confirmation prompt
│
├── deploy                   Queue a DEPLOY job (interactive zone → spec → cluster selection)
├── provision                 Alias for deploy
├── bootstrap                 First-time cluster setup: VPC + K8s + ArgoCD (supports --queue)
├── destroy                   Tear down bootstrapped environment with confirmation
│
├── clusters
│   └── list                  Table of bootstrapped clusters
│
└── runner
    ├── register              Register runner with Alethia (saves token locally)
    └── start                 Start runner poll loop (self-hosted or cloud-hosted mode)
```

---

## Key Workflows

### Quick Start

```bash
# Install and authenticate
brew install alethia
alethia login

# Create a workspace and configure infrastructure
alethia zone create "my-project"
alethia config create

# Deploy
alethia spec apply
```

### Full Lifecycle

```bash
# Authenticate
alethia login

# Create workspace
alethia zone create "production"

# Design infrastructure (6-step interactive TUI)
#   Step 1: Select zone + basics (name, environment, region)
#   Step 2: Platform selection (EKS/GKE/AKS, instance types, autoscaling)
#   Step 3: Git repositories (infra repo, app repo)
#   Step 4: Network + advanced (VPC CIDR, NAT gateway, DNS)
#   Step 5: Data services (databases, caches, queues)
#   Step 6: Review + submit
alethia config create

# Preview what will be provisioned
alethia config get my-spec-name

# Deploy to cloud
alethia spec apply

# When done, tear down cleanly
alethia destroy
```

### Runner Setup

```bash
# Register a runner with Alethia (gets runner ID + token)
alethia runner register --name "prod-runner" --mode cloud-hosted

# Start the runner daemon
# Polls Alethia every 10s for jobs, sends heartbeat every 30s
alethia runner start
```

### CLI Authentication Flow

```bash
# alethia login triggers device code flow:
# 1. CLI requests device code from Alethia
# 2. User opens browser to /cli/login?device_code=XXX&verification_code=YYY
# 3. User approves in browser
# 4. CLI receives refresh token via /api/auth/cli/exchange
# 5. Token stored in ~/.config/alethia/auth.json
alethia login

# Clear stored credentials
alethia logout
```

---

## Interactive TUI Details

Alethia uses Charmbracelet's `huh` library for rich terminal forms. Key interactions:

### `alethia config create` — 6-Step Wizard

| Step | Fields | Notes |
|------|--------|-------|
| 1. Zone & Basics | Zone selector, project name, environment (dev/staging/prod), region | Region list is provider-specific |
| 2. Platform | Cloud provider, K8s version, instance types, min/desired/max nodes | Supports Karpenter (AWS), Autopilot (GCP) |
| 3. Repositories | Git provider, infra repo, app repo | Fetches repos from connected Git provider |
| 4. Network & Advanced | VPC CIDR, NAT gateway mode, DNS zone, domain | Can use existing VPC |
| 5. Data Services | Databases (engine, version, size), caches, queues | Multi-item arrays |
| 6. Review | Summary table, confirm or go back | Shows estimated cost |

### `alethia spec apply` — Interactive Selection

```
? Select a zone:
  > production (3 specs)
    staging (1 spec)
    development (2 specs)

? Select a spec:
  > api-backend (us-east-1, ACTIVE)
    web-frontend (eu-west-1, DRAFT)

? Select a runner:
  > prod-runner (ONLINE, us-east-1)
    self-hosted (ONLINE, local)
```

---

## Envisioned Commands

These commands map Alethia web features to the CLI. They are not yet implemented but represent the natural CLI evolution.

### Monitoring & Visibility

| Command | Maps from (Alethia) | Purpose |
|---------|---------------------|---------|
| `alethia plan [spec-name]` | Terraform plan viewer | Run terraform plan and show resource diff without applying |
| `alethia cost [spec-name]` | Cost sidebar | Show monthly cost breakdown by component |
| `alethia status [spec-name]` | Spec detail page | Per-component provisioning status (network: ACTIVE, cluster: PROVISIONING, ...) |
| `alethia logs [job-id]` | Job log viewer | Stream real-time job logs to terminal |

### Runner Management

| Command | Maps from (Alethia) | Purpose |
|---------|---------------------|---------|
| `alethia runner list` | Runners dashboard | List all registered runners with status |
| `alethia runner status` | Runners dashboard | Show health, uptime, active jobs for a specific runner |
| `alethia runner destroy` | Runner management | Tear down cloud-hosted runner infrastructure |

### Integrations

| Command | Maps from (Alethia) | Purpose |
|---------|---------------------|---------|
| `alethia integrations list` | Integrations page | Show connected cloud + git providers with status |

---

## Code Examples for Landing Page

### Hero Terminal Snippet

```bash
$ brew install alethia
$ alethia login
  ✓ Opening browser for authentication...
  ✓ Authenticated as borislav@tovr.eu

$ alethia config create
  ┌─────────────────────────────────────┐
  │  Plant a Spec — Step 1 of 6        │
  │                                     │
  │  Zone:    production            │
  │  Project:     api-backend           │
  │  Environment: production            │
  │  Region:      eu-west-1             │
  │  Provider:    AWS                   │
  └─────────────────────────────────────┘
```

### Multi-Cloud Example

```bash
# Same CLI, any cloud
$ alethia config create --provider aws    # EKS + Aurora + ElastiCache
$ alethia config create --provider gcp    # GKE + Cloud SQL + Memorystore
$ alethia config create --provider azure  # AKS + Azure DB + Azure Cache
```

### Deployment Flow

```bash
$ alethia spec apply
  ? Select zone: production
  ? Select spec: api-backend (eu-west-1)
  ? Select runner: prod-runner (ONLINE)

  ✓ Job queued: DEPLOY #42
  ✓ Runner claimed job
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
| Auth token | `~/.config/alethia/auth.json` | Alethia refresh token from `alethia login` |
| Runner credentials | `~/.config/alethia/runner.json` | Runner ID + token from `alethia runner register` |
| Workspace state | `~/.alethia/workspaces/{zone}-{env}/` | Local Terraform state and tfvars |
