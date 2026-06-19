# Feature Specs

Organized by product surface. The goal is to make the Alethia/Trellis platform trackable and easy to promote into Vintner documentation.

## Folder Map

| Folder | Purpose |
| --- | --- |
| `vine-schema-redesign/` | **Active** — Normalize configurations into modular component tables with per-component status. |
| `runner-provisioning/` | **Active** — MVP design: cloud-hosted runner, AWS connection, job queue, E2E test plan. |
| `architecture/` | Platform architecture: ArgoCD pivot, bootstrap logging, GitOps wiring, and the system overview. |
| `alethia-legacy-migration/` | Canonical plan for porting `apps/legacy-cli` into `apps/cli` and tightening the Trellis integration. |
| `cli/` | Alethia CLI implementation plans: dependency checks, local provisioning, teardown, release, UX. |
| `control-plane/` | Trellis-side plans: auth, cloud identity (AWS onboarding), Git providers. |
| `trellis-ui/` | Dashboard and UI improvement specs. |
| `configs/` | Configuration-related specs. |
| `fixtures/` | Example legacy installer configs used for compatibility validation. |
| `archive/` | Historical plans (Tendril-era) kept for context only. |

## Rules For New Feature Specs

- Put new work in the owning folder above.
- Prefer updating the canonical migration docs when a task affects legacy CLI parity, Alethia, Trellis API contracts, AWS auth, GitOps, or Vintner documentation.
- Do not add new top-level single-file feature docs — use the appropriate subfolder.
