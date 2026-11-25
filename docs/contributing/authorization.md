<!-- Moved out of the user docs (apps/docs, /concepts/access-control/architecture and /open-core) by the concepts rework: contributor material. -->

# Authorization internals and the open-core boundary

How the access-control layer described in the user docs
([Access control](https://alethialabs.io/docs/concepts/access-control)) is built.

## Where it lives

| Path | What it holds |
| --- | --- |
| `apps/console/lib/authz/types.ts` | The `Pdp` contract, `Actor`, `ResourceRef`, `Decision`, `ForbiddenError` |
| `apps/console/lib/authz/registry.ts` | Registry-as-code: resources, actions, the matrix, the built-in roles |
| `apps/console/lib/authz/postgres-rbac-pdp.ts` | The community engine |
| `apps/console/lib/authz/evaluate.ts` | Pure decision helpers, unit-tested without a database |
| `apps/console/lib/authz/guard.ts` | `authorize()` / `authorizeCli()` call-site helpers |
| `apps/console/lib/authz/seed.ts` | Seeds permissions and roles from the registry at boot |
| `apps/console/lib/enterprise.ts` | The single open-core integration point and the `ee/` loader |
| `apps/console/lib/auth/scope.ts` | `getActiveScope()` |
| `apps/console/lib/db/index.ts` | `withScope()` / `withOwnerScope()` (RLS) |

## The PDP contract

```ts
interface Pdp {
  can(actor, action, resource): Promise<Decision>;
  enforce(actor, action, resource): Promise<void>; // throws ForbiddenError on deny
  bulkCheck(actor, checks[]): Promise<Decision[]>;
  listAccessible(actor, action, resourceType): Promise<string[]>;
}
```

Call sites depend on this interface only, and get the engine from `getPdp()`.

## PostgresRbacPDP

1. One query gathers the actor's grants matching the org, the principal and the permission key; each
   grant's `resource_id` is `NULL` for org-wide.
2. A recursive CTE computes the target's ancestors (project → org).
3. `coversResource(grantResourceIds, resourceId, ancestorIds)` decides: an org-wide grant covers
   everything, otherwise the grant must name the resource or an ancestor. No grant ⇒ deny.
4. `enforce` throws `ForbiddenError` (403) and records the decision in the Activity log: every
   denial and every successful non-read action.

`listAccessible` returns every id of the type for an org-wide grant, otherwise the granted resources
and their descendants.

## Registry-as-code

Resources, actions, the matrix and the built-in roles are exhaustive string-literal unions in
`registry.ts`. The `permission`, `role` and `role_permission` tables are seeded from it at boot
(idempotent; built-in roles have fixed UUIDs), and an unhandled action is a compile error.

## Open-core seams

| Seam | Accessor | Community default | Enterprise |
| --- | --- | --- | --- |
| Policy engine | `getPdp()` | `PostgresRbacPDP` | `OpenFgaPdp` (optional) |
| Tenancy scope | `getActiveScope(userId)` | personal org (`orgId == userId`) | the member's active org |
| Auth plugins | `getAuthPlugins()` | `[]` | Better Auth `organization()` + SSO |
| Entitlements | `getEntitlements(actor)` | community entitlements | license-derived flags |

`lib/enterprise.ts` is the only file allowed to name the enterprise package. It loads it
synchronously and tolerantly (Better Auth needs its plugins at construction time); `register(core)`
receives a `CoreContext` (`db`, `orgAc`, `orgRoles`, …), so `ee/` imports only erased types from the
core. With the package absent, every seam keeps its default.

## Request lifecycle

Server actions call `authorize(action, resource)`; CLI and stream routes call
`authorizeCli(req, action, resource)` after verifying the token. Both resolve the actor with
`getActiveScope`, call `getPdp().enforce(...)`, then query under `withScope()` / `withOwnerScope()`
so RLS limits rows to the active org. CLI and stream routes use the service connection, which
bypasses RLS, so they also scope their queries by org explicitly.

## CI guards

- **boundary guard**: fails if any file other than `lib/enterprise.ts` imports the enterprise package.
- **`check:authz-scope`**: fails if a server action, CLI route or stream route filters by `user_id`
  instead of going through `authorize`/`enforce` and org scoping.
- **no-Supabase guard**: a legacy guard from the database migration.
- The Community build is built and tested with the enterprise package absent.

## Swapping the engine

Moving to OpenFGA is a binding flip plus a tuple backfill: the enterprise module registers
`OpenFgaPdp`; no call site changes.
