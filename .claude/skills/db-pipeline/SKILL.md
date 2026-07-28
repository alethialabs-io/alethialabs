---
name: db-pipeline
description: The Alethia database pipeline — Drizzle schema changes, generating and applying migrations, the un-mergeable linear snapshot chain, JSONB column typing, and drizzle-zod validators. Use whenever you add or change a table, column, enum, index, trigger or RLS policy, hit a migration collision, or need to type a JSONB field.
license: AGPL-3.0-only
---

# The database pipeline

Drizzle ORM + postgres-js on self-hosted Postgres. **Never edit a generated migration file
by hand.**

## Changing the schema

1. Edit `apps/console/lib/db/schema/*.ts` — one file per domain (jobs, runners, projects, …).
2. `pnpm -F console db:generate` — drizzle-kit diffs the schema and writes a new SQL migration
   into `apps/console/lib/db/migrations/`, updating the `meta/` journal.
3. Migrations apply via `apps/console/scripts/migrate.mjs` (the `migrate` Docker target): it
   runs the generated migrations, then `apps/console/lib/db/programmables.sql` (functions,
   triggers, RLS), then sets the least-privileged app-role password from
   `ALETHIA_APP_DB_PASSWORD`.

## The rule that actually bites: the chain is linear and un-mergeable

Drizzle's `meta/*_snapshot.json` files form a **single linear chain** — each points at its
parent's id. They cannot be merged. If two branches, worktrees or sessions each run
`db:generate` from the same base and both land, two snapshots share a `prevId` and generation
is permanently jammed **for everyone**. People then hand-author SQL without snapshots, which
compounds the drift.

- **Always rebase onto the target branch before generating.**
- **Never generate in two worktrees at once.** `scripts/db-generate.sh` is lock-guarded
  (atomic `/tmp/alethia-migrate.lock`) and warns when you are not rebased.
- If your branch *and* the target both added a migration: **delete your migration and its
  snapshot, rebase, regenerate** so it chains off the latest.
- The board enforces this too — at most one open issue may hold `mutex:migration`.

`db:generate` self-checks via `apps/console/scripts/check-migrations.mjs`, and CI runs
`pnpm -F console check:migrations`, so a forked history fails the build. Run it yourself
anytime.

The runtime migrator reads only `_journal.json` and the `.sql` files — never the snapshots —
so a one-time `meta/` repair can rebuild the chain without touching applied history.

## Typing JSONB columns

Column types are inferred straight from the schema (`typeof table.$inferSelect` /
`$inferInsert`). **There is no generated types file** — nothing to regenerate, nothing to
import.

For a JSONB column with a known shape, type it on the column and put the interface in
`apps/console/types/jsonb.types.ts`:

```typescript
provider_config: jsonb().$type<ClusterProviderConfig>(),
```

**Never** use `Record<string, unknown>` for a JSONB field whose shape you know. If the value
is a finite, known set, use a real enum or typed union rather than a bare `string`.

## Validators (drizzle-zod)

Derive validators from the schema instead of hand-writing them:

```typescript
import { createInsertSchema } from "drizzle-zod";
import { projectCluster } from "@/lib/db/schema";

const clusterInsert = createInsertSchema(projectCluster, {
  // refine JSONB columns with their interface types
  cluster_admins: z.custom<ClusterAdmin[]>().optional(),
  provider_config: z.custom<ClusterProviderConfig>().optional(),
});
```

Form/input schemas live in `apps/console/lib/validations/`; reusable typed query builders in
`apps/console/lib/queries/`.

## Two traps

- **Schema you edit may not be owned here.** `apps/console/lib/db/schema/platform.ts` is a
  one-line re-export of `@repo/platform/schema`; those tables are owned by `apps/admin` and are
  re-exported only so drizzle-kit sees them. Edit the package, not the re-export. `@repo/support`
  is the same shape.
- **Changing a function's return type needs an explicit drop.** Postgres raises `42P13` on
  `CREATE OR REPLACE` when the return type changes; `programmables.sql` must
  `DROP FUNCTION IF EXISTS` first. This took production down once.

## Related

- Reading config across frontend / runner / CLI: `apps/console/lib/queries/`
- Tenant isolation and RLS review: `.claude/skills/alethia-security-review/SKILL.md`
