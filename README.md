# ADP ItGix Platform

An internal developer platform for provisioning and managing cloud infrastructure through a web control plane and CLI, backed by GitOps reconciliation.

## Architecture

| Component | Role |
| --- | --- |
| **Trellis** (`apps/trellis`) | Web control plane — Next.js dashboard, Supabase state store, auth, configuration management |
| **Grape** (`apps/grape`) | Go CLI — authentication, bootstrap, deployment, teardown, GitOps operations |
| **Vintner** (`apps/docs`) | Documentation site (Next.js / Fumadocs) |
| **ArgoCD** | In-cluster GitOps reconciler installed during bootstrap |

## Monorepo Structure

```
apps/
  trellis/       — Web control plane (Next.js + Supabase)
  grape/         — CLI (Go)
  docs/          — Documentation (Fumadocs)
packages/
  ui/            — Shared React component library
  eslint-config/ — ESLint configurations
  typescript-config/ — Shared tsconfig
spec/
  features/      — Active project documentation and feature specs
  thesis/        — Academic thesis (static reference, not active docs)
```

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm
- Go 1.21+
- Turborepo (`npm i -g turbo`)

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
turbo dev --filter=grape
```

### Build

```bash
turbo build
```

## Documentation

- [Feature specs and architecture](./spec/features/)
- [Thesis chapters](./spec/thesis/) (academic reference)
