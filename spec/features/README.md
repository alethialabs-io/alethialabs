# Feature Specs

Organized by product surface. The goal is to make the Grape/Trellis platform trackable and easy to promote into Vintner documentation.

## Folder Map

| Folder | Purpose |
| --- | --- |
| `architecture/` | Platform architecture: ArgoCD pivot, bootstrap logging, GitOps wiring, and the system overview. |
| `grape-legacy-migration/` | Canonical plan for porting `apps/legacy-cli` into `apps/grape` and tightening the Trellis integration. |
| `cli/` | Grape CLI implementation plans: dependency checks, local provisioning, teardown, release, UX. |
| `control-plane/` | Trellis-side plans: auth, cloud identity (AWS onboarding), Git providers. |
| `trellis-ui/` | Dashboard and UI improvement specs. |
| `configs/` | Configuration-related specs. |
| `fixtures/` | Example legacy installer configs used for compatibility validation. |
| `archive/` | Historical plans (Tendril-era) kept for context only. |

## Rules For New Feature Specs

- Put new work in the owning folder above.
- Prefer updating the canonical migration docs when a task affects legacy CLI parity, Grape, Trellis API contracts, AWS auth, GitOps, or Vintner documentation.
- Do not add new top-level single-file feature docs — use the appropriate subfolder.
