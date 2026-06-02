# ADP ItGix Platform

An internal developer platform for provisioning and managing multi-cloud infrastructure through a web control plane and CLI, backed by GitOps reconciliation.

Built by **Borislav Borisov** — [GitHub](https://github.com/bobikenobi12) · [LinkedIn](https://www.linkedin.com/in/bbor1sov)

## Architecture

| Component | Role |
| --- | --- |
| **Trellis** (`apps/trellis`) | Web control plane — Next.js dashboard, Supabase state store, auth, configuration management, job orchestration |
| **Grape** (`apps/grape`) | Go CLI — authentication, vineyard/vine management, plan/deploy/destroy operations, worker registration |
| **Tendril** (`apps/tendril`) | Go worker — claims provisioning jobs from the queue, executes Terraform, streams logs back to Trellis |
| **Grape-Core** (`packages/grape-core`) | Shared Go library — cloud provider interfaces, embedded Terraform templates, config types |
| **Vintner** (`apps/vintner`) | Documentation site (Next.js / Fumadocs) |
| **ArgoCD** | In-cluster GitOps reconciler installed during bootstrap |

## Tech Stack

| Layer | Technology |
| --- | --- |
| Web Control Plane | Next.js 16, React 19, TypeScript 5.9, Supabase, Tailwind CSS 4, shadcn/ui |
| CLI | Go 1.25, Cobra, Charmbracelet TUI (bubbletea, huh, lipgloss) |
| Worker | Go 1.25, Terraform exec, multi-cloud SDKs (AWS, GCP, Azure) |
| Documentation | Next.js 16, Fumadocs, MDX |
| Infrastructure | Terraform (AWS ECS Fargate, ECR, Lambda), ArgoCD |
| Monorepo | pnpm workspaces, Turborepo, Go workspaces |
| CI/CD | GitHub Actions, GoReleaser, release-please |

## Monorepo Structure

```
apps/
  trellis/           — Web control plane (Next.js + Supabase)
  grape/             — CLI (Go + Cobra + Charmbracelet)
  tendril/           — Provisioning worker (Go)
  vintner/           — Documentation site (Fumadocs)
packages/
  grape-core/        — Shared Go library (cloud providers, Terraform templates)
  ui/                — Shared React component library
  charts/            — Helm charts
  eslint-config/     — ESLint configurations
  typescript-config/ — Shared tsconfig
infra/
  platform/          — Platform infrastructure (ECR, ECS, Lambda scaler)
  templates/         — Vine IaC templates (AWS, GCP, Azure)
  onboarding/        — Cloud account bootstrap scripts
supabase/
  migrations/        — PostgreSQL schema migrations
spec/
  features/          — Active feature specs and architecture docs
  thesis/            — Academic thesis (static reference)
```

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 9+
- Go 1.25+
- Turborepo (`npm i -g turbo`)
- Supabase CLI (`brew install supabase/tap/supabase`)

### Install Grape CLI (Homebrew)

```bash
brew tap bobikenobi12/bb-thesis-2026 https://github.com/bobikenobi12/bb-thesis-2026
brew install grape
```

If the repository is private, ensure your local Git environment is authenticated with GitHub (e.g. `export HOMEBREW_GITHUB_API_TOKEN=your_token`).

### Development

```bash
# All apps
turbo dev

# Specific app
turbo dev --filter=trellis
turbo dev --filter=vintner

# Grape CLI (Go)
cd apps/grape && go run .
```

### Build

```bash
turbo build
```

### Test

```bash
# Trellis unit tests
pnpm -F trellis test

# Trellis E2E
pnpm -F trellis test:e2e

# Go tests
cd apps/grape && go test ./...
```

## Infrastructure

The `infra/` directory contains all Terraform configurations:

- **`platform/`** — Core platform infrastructure: ECR container registry, ECS Fargate tendril workers (multi-region), Lambda auto-scaler (EventBridge-triggered, checks job queue depth every minute)
- **`templates/vine/`** — Per-cloud IaC templates applied into user accounts (AWS EKS, GCP GKE, Azure AKS with associated networking, databases, and security groups)
- **`templates/tendril/`** — Self-hosted worker deployment template
- **`onboarding/`** — Cloud account bootstrap (IAM cross-account roles for AWS, workload identity federation for GCP, federated identity for Azure)

## Documentation

- [Vintner docs site](./apps/vintner/) — hosted documentation portal
- [Feature specs](./spec/features/) — active project documentation
- [Thesis chapters](./spec/thesis/) — academic reference
