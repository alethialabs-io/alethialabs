# Vine Schema Redesign

Replace the monolithic `configurations` table (47 columns) with a normalized schema where each infrastructure component (VPC, EKS, RDS, Redis, DNS, Repositories) has its own table with independent status tracking.

## Documents

| File | Purpose |
|------|---------|
| [01-current-state.md](./01-current-state.md) | Analysis of the current schema, what's used vs unused, and known issues |
| [02-new-schema.md](./02-new-schema.md) | Complete SQL for the new tables, view, and RLS policies |
| [03-migration-plan.md](./03-migration-plan.md) | How to migrate from old to new without breaking anything |
| [04-provisioner-integration.md](./04-provisioner-integration.md) | How the Grape worker reads the new schema and updates component statuses |
| [05-trellis-integration.md](./05-trellis-integration.md) | Server actions, form changes, and UI for per-component status |
| [06-infracost-integration.md](./06-infracost-integration.md) | Real-time cost estimation in the form + accurate breakdown from the worker |
| [07-template-strategy.md](./07-template-strategy.md) | How templates are embedded, private module access, and versioning |
| [08-security-and-gaps.md](./08-security-and-gaps.md) | Security review, known gaps, and fixes for all 7 documents |

## Key Decisions

- The old `configurations` table gets deprecated, not deleted, until all consumers are migrated
- A `vine_full` SQL view provides backward compatibility so the Go provisioner works during the transition
- Each component table has a `status` column — the worker updates these as it provisions
- Template repo URLs have sensible defaults in the schema (no more empty `git@:.git` errors)
- The `vines` table is the orchestrator — lightweight, just identity + project + environment + overall status
