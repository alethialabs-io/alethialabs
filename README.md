# Alethia Labs

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

An open-source, multi-cloud internal developer platform for provisioning and managing infrastructure through a web control plane and CLI, backed by GitOps reconciliation.

© 2026 **Alethia Labs OÜ** — open core ([see Licensing](#licensing)). Maintained by [Borislav Borisov](https://github.com/bobikenobi12) ([LinkedIn](https://www.linkedin.com/in/bbor1sov)).

> Some internal component names — the `Alethia` control-plane app, the `alethia` CLI, and `core` — are codenames retained from earlier development and will be renamed in a later pass. The product is **Alethia Labs**.

## Architecture

| Component | Role |
| --- | --- |
| **Alethia** (`apps/console`) | Web control plane — Next.js dashboard, Postgres (Drizzle) state store, Better Auth, configuration management, job orchestration |
| **alethia** (`apps/cli`) | Go CLI — authentication, vineyard/vine management, plan/deploy/destroy operations, worker registration |
| **Runner** (`apps/runner`) | Go worker — claims provisioning jobs from the queue, executes Terraform, streams logs back to Alethia |
| **core** (`packages/core`) | Shared Go library — cloud provider interfaces, embedded Terraform templates, config types |
| **docs** (`apps/docs`) | Documentation site (Next.js / Fumadocs) |
| **ArgoCD** | In-cluster GitOps reconciler installed during bootstrap |

## Tech Stack

| Layer | Technology |
| --- | --- |
| Web Control Plane | Next.js 16, React 19, TypeScript 5.9, Postgres + Drizzle, Better Auth, Tailwind CSS 4, shadcn/ui |
| CLI | Go 1.25, Cobra, Charmbracelet TUI (bubbletea, huh, lipgloss) |
| Worker | Go 1.25, Terraform exec, multi-cloud SDKs (AWS, GCP, Azure) |
| Documentation | Next.js 16, Fumadocs, MDX |
| Infrastructure | Terraform (AWS ECS Fargate, ECR, Lambda), ArgoCD |
| Monorepo | pnpm workspaces, Turborepo, Go workspaces |
| CI/CD | GitHub Actions, GoReleaser, release-please |

## Monorepo Structure

```
apps/
  console/           — Web control plane (Next.js + Postgres/Drizzle + Better Auth)
  alethia/             — CLI (Go + Cobra + Charmbracelet)
  runner/           — Provisioning worker (Go)
  docs/           — Documentation site (Fumadocs)
packages/
  core/        — Shared Go library (cloud providers, Terraform templates)
  ui/                — Shared React component library
  charts/            — Helm charts
  eslint-config/     — ESLint configurations
  typescript-config/ — Shared tsconfig
infra/
  platform/          — Platform infrastructure (ECR, ECS, Lambda scaler)
  templates/         — Vine IaC templates (AWS, GCP, Azure)
  connector/         — Cloud account bootstrap scripts
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
- Docker + Compose v2 (for the self-host bundle: Postgres + S3-compatible storage)

### Install the `alethia` CLI

**macOS / Linux** (`curl`):

```bash
curl -fsSL https://get.alethialabs.io | sh
```

**Windows** (PowerShell):

```powershell
irm https://get.alethialabs.io/install.ps1 | iex
```

**Homebrew** (macOS / Linux):

```bash
brew install alethialabs-io/alethialabs/alethia
```

**Docker**:

```bash
docker run --rm ghcr.io/alethialabs-io/alethia --version
```

Pin a version with `ALETHIA_VERSION=v0.2.0` (curl/PowerShell). While the repository is private (pre-launch), set `GITHUB_TOKEN` first for the curl/PowerShell installers, and `HOMEBREW_GITHUB_API_TOKEN` for Homebrew.

### Development

```bash
# All apps
turbo dev

# Specific app
turbo dev --filter=console
turbo dev --filter=docs

# alethia CLI (Go)
cd apps/cli && go run .
```

### Build

```bash
turbo build
```

### Test

```bash
# Alethia unit tests
pnpm -F console test

# Alethia E2E
pnpm -F console test:e2e

# Go tests
cd apps/cli && go test ./...
```

## Infrastructure

The `infra/` directory contains all Terraform configurations:

- **`platform/`** — Core platform infrastructure: ECR container registry, ECS Fargate node workers (multi-region), Lambda auto-scaler (EventBridge-triggered, checks job queue depth every minute)
- **`templates/vine/`** — Per-cloud IaC templates applied into user accounts (AWS EKS, GCP GKE, Azure AKS with associated networking, databases, and security groups)
- **`templates/node/`** — Self-hosted worker deployment template
- **`connector/`** — Cloud account bootstrap (IAM cross-account roles for AWS, workload identity federation for GCP, federated identity for Azure)

## Self-Hosting

Run the whole platform (console · docs · Postgres · object storage · runner) as one
docker-compose bundle on any cloud VM:

```bash
curl -fsSL https://raw.githubusercontent.com/alethialabs-io/alethialabs/main/deploy/install.sh \
  | DOMAIN=alethia.example.com ACME_EMAIL=you@example.com sh
```

See the [Self-Hosting guide](./apps/docs/content/docs/self-hosting/) (quickstart, configuration,
per-cloud Terraform, upgrading) and the distribution roadmap in
[`spec/mvp/09-self-host-distribution.md`](./spec/mvp/09-self-host-distribution.md).

## Documentation

- [docs docs site](./apps/docs/) — hosted documentation portal
- [Feature specs](./spec/features/) — active project documentation
- [Thesis chapters](./spec/thesis/) — academic reference

## Licensing

Alethia Labs is **open core**:

- The core is licensed under the GNU Affero General Public License v3.0 (`AGPL-3.0-only`) — see [`LICENSE`](./LICENSE).
- Cloud / enterprise features under [`ee/`](./ee/) are commercially licensed (`LicenseRef-Alethia-Commercial`); production use requires a subscription.
- A directory-by-directory map is in [`LICENSING.md`](./LICENSING.md); third-party attributions are in [`NOTICE`](./NOTICE).

Contributions require signing our [CLA](./cla/) — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). © 2026 Alethia Labs OÜ.
