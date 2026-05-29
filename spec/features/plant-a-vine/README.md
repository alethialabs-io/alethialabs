# Plant a Vine — Configuration Form

Spec for the `/dashboard/configure` page. This is the core form where users define infrastructure configurations (Vines) that get provisioned by the central Fargate worker.

**This spec has been updated to reflect the new vine schema** (see `spec/features/vine-schema-redesign/`). The form now writes to `vines` + component tables, not the old `configurations` table.

## Documents

- [00-current-state.md](00-current-state.md) — What exists today, what's broken, what changed
- [01-page-architecture.md](01-page-architecture.md) — Full page layout, sections, field inventory
- [02-data-flow.md](02-data-flow.md) — Form state → `createVine` → component tables → `provisionVine` → Worker
- [03-implementation-plan.md](03-implementation-plan.md) — Phased implementation with acceptance criteria
- [04-template-variable-mapping.md](04-template-variable-mapping.md) — 102 Terraform variables → which component table owns each
- [05-ux-issues.md](05-ux-issues.md) — User feedback and required fixes

## Key Changes from Old Spec

| Before | After |
|--------|-------|
| Single `configurations` table (47 columns) | `vines` + 12 component tables |
| `createConfiguration()` server action | `createVine()` in `vines.ts` |
| `provisionConfiguration()` | `provisionVine()` |
| Flat form → flat DB row | Form sections → component tables |
| YAML textareas for admins/queues | Separate `vine_queues`, `vine_topics` tables |
| Manual git token entry | `vine_git_credentials` with OAuth/secret refs |
| Empty template repo URLs (crashes worker) | Defaults baked into `vine_repositories` schema |
| No cost estimation | `estimated_monthly_cost` per component via Infracost |
| No per-component status | Each component has `status` + `status_message` |
| AWS data fetched live (slow/broken) | Cached on AWS connect via worker `fetchAwsResources` |
