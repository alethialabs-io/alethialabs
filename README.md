# Alethia Labs

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![CI](https://github.com/alethialabs-io/alethialabs/actions/workflows/ci.yml/badge.svg)](https://github.com/alethialabs-io/alethialabs/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/alethialabs-io/alethialabs/badges/.github/badges/coverage.json)](./TESTING.md)
[![go coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/alethialabs-io/alethialabs/badges/.github/badges/go-coverage.json)](./TESTING.md)

An open-source, multi-cloud internal developer platform for provisioning and managing infrastructure through a web control plane and CLI, backed by GitOps reconciliation.

© 2026 **Alethia Labs** — open core ([see Licensing](#licensing)). Maintained by [Borislav Borisov](https://github.com/bobikenobi12) ([LinkedIn](https://www.linkedin.com/in/bbor1sov)).

> Some internal component names — the `Alethia` control-plane app, the `alethia` CLI, and `core` — are codenames retained from earlier development and will be renamed in a later pass. The product is **Alethia Labs**.

## Architecture

| Component | Role |
| --- | --- |
| **Alethia** (`apps/console`) | Web control plane — Next.js dashboard, Postgres (Drizzle) state store, Better Auth, configuration management, job orchestration |
| **alethia** (`apps/cli`) | Go CLI — authentication, project management, plan/deploy/destroy operations, runner registration |
| **Runner** (`apps/runner`) | Go runner — claims provisioning jobs, runs OpenTofu behind a fail-closed verification gate, streams logs back |
| **core** (`packages/core`) | Shared Go library — cloud provider interfaces, embedded OpenTofu templates, the `verify` policy gate and `drift` posture |
| **docs** (`apps/docs`) | Documentation site (Next.js / Fumadocs) |
| **ArgoCD** | In-cluster GitOps reconciler installed during bootstrap |

## Tech Stack

| Layer | Technology |
| --- | --- |
| Web Control Plane | Next.js 16, React 19, TypeScript 5.9, Postgres + Drizzle, Better Auth, Tailwind CSS 4, shadcn/ui |
| CLI | Go 1.25, Cobra, Charmbracelet TUI (bubbletea, huh, lipgloss) |
| Runner | Go 1.25, OpenTofu exec, multi-cloud SDKs (AWS, GCP, Azure, Alibaba) |
| Documentation | Next.js 16, Fumadocs, MDX |
| Infrastructure | OpenTofu (per-cloud project templates), Hetzner control plane + runner fleet, ArgoCD |
| Monorepo | pnpm workspaces, Turborepo, Go workspaces |
| CI/CD | GitHub Actions, GoReleaser, release-please |

## Monorepo Structure

```
apps/
  console/           — Web control plane (Next.js + Postgres/Drizzle + Better Auth)
  cli/               — CLI (Go + Cobra + Charmbracelet)
  runner/            — Provisioning runner (Go)
  docs/              — Documentation site (Fumadocs)
  marketing/         — Public marketing site (hosted only)
  blog/              — Blog (Next.js + Velite)
  admin/             — Internal staff support dashboard
packages/
  core/              — Shared Go library (cloud providers, OpenTofu templates, verify, drift)
  ui/                — Shared shadcn/ui design system (@repo/ui)
  brand/             — Logo, design tokens, metadata generators
  email/             — Transactional email infrastructure (SES + react-email)
  platform/          — Schema owned by apps/admin, re-exported into console
  support/           — Support-case schema, storage, validations
  plan-catalog/      — Plan display catalog (console billing + marketing pricing)
  assets/            — Static files synced into each app's public/
  eslint-config/     — ESLint configurations
  typescript-config/ — Shared tsconfig
infra/
  templates/         — Project IaC templates (AWS, GCP, Azure, Alibaba)
  connector/         — Cloud account bootstrap scripts
  cp-hetzner/        — Control-plane infrastructure
  sandbox/           — The developer sandbox box
ee/                  — Enterprise tier (commercially licensed)
deploy/              — Self-host bundle: compose overlays, Caddy, Helm chart, install.sh
```
```

## Getting Started

### Prerequisites

- Node.js 22+ (see `.nvmrc`)
- pnpm 9+
- Go 1.25+
- Docker + Compose v2 (for the self-host bundle: Postgres + S3-compatible storage)
- An SSH key and a Hetzner Cloud token, if you want a dev environment (see below)

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
brew install alethialabs-io/tap/alethia
```

**Docker**:

```bash
docker run --rm ghcr.io/alethialabs-io/alethia --version
```

Pin a version with `ALETHIA_VERSION=v0.2.0` (curl/PowerShell). While the repository is private (pre-launch), set `GITHUB_TOKEN` first for the curl/PowerShell installers, and `HOMEBREW_GITHUB_API_TOKEN` for Homebrew.

### Development

The app does not run on your laptop. Each branch gets its own environment on a shared
sandbox box, reachable over HTTPS:

```bash
pnpm env:up      # this branch gets a database, storage, an auth store, and a URL
pnpm env:push    # after editing — sync the working tree
pnpm env:logs    # tail the console (sign-in codes are printed here)
pnpm env:status  # every environment, who holds it, capacity
```

`pnpm env:up` prints the URL. Full detail, including how to sign in, is in
[`.claude/skills/dev/SKILL.md`](./.claude/skills/dev/SKILL.md) and
[`infra/sandbox/README.md`](./infra/sandbox/README.md).

Local dev servers are deliberately blocked — see [`CLAUDE.md`](./CLAUDE.md). Building,
type-checking, linting and unit tests all still run locally.

```bash
# alethia CLI (Go)
cd apps/cli && go run .
```

### Build

```bash
pnpm build
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

The `infra/` directory contains all OpenTofu configurations. The managed runner fleet is
sized by an **in-app scaler** (`apps/console/lib/fleet/`), not by a Lambda:

- **`cp-hetzner/`** — The control plane: one Hetzner VPS running the self-host bundle behind Caddy and a Cloudflare tunnel
- **`sandbox/`** — The developer sandbox box, one environment per branch
- **`templates/project/`** — Per-cloud IaC templates applied into user accounts (AWS EKS, GCP GKE, Azure AKS with associated networking, databases, and security groups)
- **`templates/runner/`** — Self-hosted runner deployment template
- **`connector/`** — Cloud account bootstrap (IAM cross-account roles for AWS, workload identity federation for GCP, federated identity for Azure)

## Self-Hosting

Run the whole platform (console · docs · Postgres · object storage · runner) as one
docker-compose bundle on any cloud VM:

```bash
curl -fsSL https://raw.githubusercontent.com/alethialabs-io/alethialabs/main/deploy/install.sh \
  | DOMAIN=alethia.example.com ACME_EMAIL=you@example.com sh
```

See the [Self-Hosting guide](./apps/docs/content/docs/self-hosting/) (quickstart, configuration,
per-cloud Terraform, upgrading).

## Documentation

- [Docs site](./apps/docs/) — hosted documentation portal
- [`CLAUDE.md`](./CLAUDE.md) — the operating contract (worktrees, branch flow, running the app)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — per-component reference
- [`TESTING.md`](./TESTING.md) — the testing bar and coverage gates
- Product, GTM and feature specs live in the private `alethialabs-io/dataroom` repo.

## Licensing

Alethia Labs is **open core**:

- The core is licensed under the GNU Affero General Public License v3.0 (`AGPL-3.0-only`) — see [`LICENSE`](./LICENSE).
- Cloud / enterprise features under [`ee/`](./ee/) are commercially licensed (`LicenseRef-Alethia-Commercial`); production use requires a subscription.
- A directory-by-directory map is in [`LICENSING.md`](./LICENSING.md); third-party attributions are in [`NOTICE`](./NOTICE).

Contributions require signing our [CLA](./cla/) — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). © 2026 Alethia Labs.
