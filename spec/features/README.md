# Feature Specs

Organized by product surface. The goal is to make the Alethia/Alethia platform trackable and easy to promote into Docs documentation.

## Folder Map

| Folder | Purpose |
| --- | --- |
| `mvp-roadmap/` | **Active** — Epic roadmap to a launchable MVP, grounded in the current 85–95%-built state (E1 hero-flow hardening, cost, self-host, fleet, licensing; orgs/SSO + connectors are in-flight lanes). |
| `spec-schema-redesign/` | **Active** — Normalize configurations into modular component tables with per-component status. |
| `runner-provisioning/` | **Active** — MVP design: cloud-hosted runner, AWS connection, job queue, E2E test plan. |
| `architecture/` | Platform architecture: ArgoCD pivot, bootstrap logging, GitOps wiring, and the system overview. |
| `alethia-legacy-migration/` | Canonical plan for porting `apps/legacy-cli` into `apps/cli` and tightening the Alethia integration. |
| `cli/` | Alethia CLI implementation plans: dependency checks, local provisioning, teardown, release, UX. |
| `control-plane/` | Alethia-side plans: auth, cloud identity (AWS onboarding), Git providers. |
| `alethia-ui/` | Dashboard and UI improvement specs. |
| `configs/` | Configuration-related specs. |
| `fixtures/` | Example legacy installer configs used for compatibility validation. |
| `archive/` | Historical plans (Runner-era) kept for context only. |

## Rules For New Feature Specs

- Put new work in the owning folder above.
- Prefer updating the canonical migration docs when a task affects legacy CLI parity, Alethia, Alethia API contracts, AWS auth, GitOps, or Docs documentation.
- Do not add new top-level single-file feature docs — use the appropriate subfolder.
