# 07 — Auth, RBAC & SSO

**Status:** Accepted (architecture). This doc defines Alethia's identity and authorization, which is **both** the security foundation **and** the open-core paid boundary (orgs/RBAC/SSO are the commercial `ee/` tier — see [12-licensing-open-core](12-licensing-open-core.md)).

Framing that drives every choice: today there is **no real authorization system** — just single-user RLS (`user_id`-scoped), no org/role/permission/membership tables. So this is *introducing the first authorization layer while removing the only one that exists* ([06-self-hosting-architecture](06-self-hosting-architecture.md)). RBAC/orgs is 100% net-new → the paywall is net-new work, not a clawback.

---

## Part A — Identity: Better Auth (MIT)

One in-process auth library (MIT, Drizzle adapter) covers **all three** principals and the paid tier:

- **Web users:** social (GitHub/Google native; GitLab/Bitbucket via `genericOAuth`) + magic link; sessions via `auth.api.getSession()`; middleware route-protection. Git OAuth tokens live in Better Auth's `account` table (retires `provider_tokens`).
- **CLI (`alethia`):** keep the existing custom device-code JWT for phase 1 (decoupled already); optionally migrate to Better Auth's RFC-8628 `deviceAuthorization` plugin later to unify CLI identity with SSO.
- **runners (runners):** unchanged — `verifyRunnerToken` (sha256 runner token). A runner **acts as the user who queued the job**, so its authority is bounded by that user's grants.
- **Paid tier (plugins):** the `organization` plugin (members, teams, custom roles, `createAccessControl`/`hasPermission`) and `@better-auth/sso` (SAML 2.0 + OIDC, per-org IdP) are added **by the `ee/` build** at config time via a `getAuthPlugins()` registration point — `[]` in community, `[organization(), sso(), ...]` in enterprise. No `if/else` in core.

---

## Part B — Authorization: one PDP, two backends

### The Policy Decision Point (the load-bearing abstraction)

A single module — `apps/alethia/lib/authz/` — is the **only** place an access decision is made:

```ts
interface PDP {
  can(actor, action, resource): Promise<Decision>
  enforce(actor, action, resource): Promise<void>   // throws 403; default for routes
  bulkCheck(actor, checks[]): Promise<Decision[]>     // batched — never loop can()
  listAccessible(actor, action, resourceType): Promise<string[]>  // the ListObjects equivalent
}
```

Three rules, enforced by CI lint:
1. **No call site decides access itself** — no `auth.uid()`, no `.eq('user_id')` as authz. The grep that finds those today becomes a guard forbidding authz logic outside `lib/authz/`.
2. **Every route / server action / CLI+runner route starts with `enforce()`** (or `listAccessible()` for lists). `getZones()` becomes `listAccessible(actor,'view','zone')` → fetch by id-set, not a bare query trusting RLS.
3. **`listAccessible` is mandatory for every list view** — this is what makes the engine swap free and kills the N+1-authz trap.

Because all three surfaces call the same `PDP`, **changing the backend never touches the ~200 call sites.**

### Community backend — `PostgresRbacPDP` (no extra service)

Keeps the small-package promise. **Scoped RBAC** as plain Drizzle queries:
- `can()` resolves the actor's grants at the relevant scope, walks **Org→Zone→Spec inheritance in SQL** (recursive CTE over `resource_hierarchy`), matches the permission. A grant on a Zone implies it on every Spec inside — no per-object assignment.
- `listAccessible()` returns the id-set from the same grants+hierarchy query.
- Better Auth `organization` is the system of record for membership + built-in roles; fine-grained per-object grants live in our own `grant` table.

### Enterprise backend — `OpenFgaPDP` (same interface)

Bind `PDP` to **OpenFGA** (Apache-2.0, CNCF Incubating) when scale/relationships demand it:
- Postgres-native (the Postgres we already run), **embeddable as a Go lib**, supports SQLite/in-memory → invisible to the community tier's footprint.
- **`ListObjects`** answers "which Zones/Specs can this user see?" in one call — every list view needs exactly this.
- **Conditions + contextual tuples** add ABAC on top of ReBAC for high-stakes actions: gate `destroy` on `environment == production → operator+ AND fresh-MFA (passed as a contextual tuple, not persisted)`. Use `HIGHER_CONSISTENCY` on the ~5 sensitive actions only (`destroy`, `manage_identities`, `manage_members`, …); cache everywhere else.
- A **grant→tuple sync writer** keeps the Postgres `grant`/`resource_hierarchy` tables the human-auditable source of truth; OpenFGA is the query engine.

**Why OpenFGA over the alternatives:** SpiceDB is the most consistency-faithful Zanzibar engine but is gRPC-first and steers to CockroachDB — too heavy for a self-hostable product. Cerbos is a clean stateless PDP but has **no `ListObjects`**, pushing every permission-filtered list back into app code. OpenFGA is the lightest credible Zanzibar engine, Postgres-native, neutrally governed (CNCF). Engine swap = a **PDP binding flip + a tuple backfill**, no call-site rewrites.

---

## Part C — Defense-in-depth: the RLS backstop

The PDP is the rich policy; **coarse Postgres RLS is the blast wall.** Different failure modes:
- PDP = hierarchical, ABAC-capable decisions — but it's app code (bugs, missed call sites).
- RLS = dumb but **unbypassable** tenant isolation — even raw SQL can't read another org's rows.

Design: every tenant table gets `org_id`; one policy per table — `USING (org_id = current_setting('app.current_org')::uuid)`. A Drizzle wrapper runs `set_config('app.current_org', orgId, true)` (transaction-scoped — the `true` is essential) at the top of each request transaction from the verified session. **Pooler-safe** (transaction mode + transaction-local var; never session-scoped). RLS is **coarse org-isolation only** — fine-grained logic stays in the PDP, so we never ship two versions of SQL policies. The Go runner uses a service-role connection that bypasses RLS but is gated by `verifyRunnerToken` + a PDP check bound to the queuing user.

**Cost:** community PDP check = one indexed Postgres query (sub-ms, same DB). Enterprise OpenFGA Check ≈ low-single-digit ms cached. `set_config` is negligible. Solve N+1 with `listAccessible()` (one query/page) and `bulkCheck()` (one round-trip) — **never loop `can()`**.

---

## Part D — Data model

Better Auth owns identity/membership; Alethia owns fine-grained authz.

```
-- Better Auth organization plugin (don't reinvent):
organization(id, name, slug)              member(id, user_id, organization_id, role)
team(...) / teamMember(...)               organizationRole(id, org_id, role, permission)  -- if dynamic AC

-- Alethia authz (net-new):
permission(key PK, resource, action, description)         -- the registry, seeded from code
role(id, organization_id NULL, name, is_builtin)          -- NULL org = built-in template
role_permission(role_id, permission_key)
grant(id, org_id, principal_type['user'|'team'], principal_id, role_id,
      resource_type, resource_id NULL)                     -- NULL resource_id = org-wide
resource_hierarchy(child_type, child_id, parent_type, parent_id)   -- Org→Zone→Spec edges
authz_audit_log(id, org_id, actor_id, action, resource_type, resource_id, decision, reason, ts)
```

- **Community PDP** reads `grant` + `role_permission` + walks `resource_hierarchy` (CTE). `member.role` gives the built-in baseline; `grant` gives per-Zone overrides.
- **Enterprise PDP** syncs `grant` + `resource_hierarchy` → OpenFGA tuples; Postgres stays the auditable record.
- `authz_audit_log` is written by the PDP itself on every `enforce()` → audit can't be forgotten at call sites (it's the enterprise audit-export feature).

---

## Part E — Permission taxonomy & avoiding role explosion

**Resources:** `org · zone · spec · node · cloud_identity · job · integration · member · audit · billing`.
**Actions:** `view · create · edit · plan · deploy · destroy · manage_identities · manage_members · manage_integrations · view_audit · export_audit · manage_billing`.

Keeping "tons of permissions" manageable:
- **Registry as code** — one typed TS file is the source of the `resource × action` matrix (seeds the `permission` table); `Action`/`Resource` are exhaustive unions so a new action can't be silently unhandled.
- **Role templates, not bespoke roles** — ship `owner / admin / operator / viewer` as built-ins (`is_builtin=true`, `org_id=null`); custom roles are org copies with deltas (most orgs never make one).
- **Hierarchy beats assignment** — assign at the highest sensible scope; Org→Zone→Spec inheritance flows it down. The single biggest lever against grant explosion; identical in both engines (SQL CTE vs OpenFGA `from parent`).
- **Scoped/wildcard grants** — `grant.resource_id = NULL` = org-wide; a Zone id = that subtree; a Spec id = that object. Three rows cover what naive systems need hundreds for.
- **Sensitive resources are narrowed, not widened** — `cloud_identity`, `manage_members`, `billing` are *not* implied by broad Zone roles; they need explicit higher grants. **Default-deny** everywhere.

---

## Part F — The open-core boundary & the 5 seams

| Capability | Community (AGPL) | Commercial `ee/` |
|---|---|---|
| Social/email/magic-link auth, sessions | ✅ | — |
| Single-tenant, per-user ownership | ✅ | — |
| Community RBAC (built-in roles, grants, hierarchy) + RLS backstop | ✅ | — |
| Organizations / teams / membership | — | ✅ |
| OpenFGA-backed RBAC, custom roles, `ListObjects` at scale | — | ✅ |
| SSO — SAML / OIDC, per-org IdP, SCIM | — | ✅ |
| Audit log export / retention | — | ✅ |
| Multi-tenancy, hosted SaaS | — | ✅ |

The seams the AGPL core exposes so `ee/` bolts on without forking (core never imports `ee/`):
1. **`AuthzPolicy` / PDP** — community per-user/RBAC impl; `ee/` OpenFGA impl.
2. **Tenancy boundary** — `getActiveScope(actor) → {ownerId, orgId?}`; community `orgId=null`.
3. **Auth-plugin registration** — `getAuthPlugins()`; `ee/` appends `organization()`/`sso()`.
4. **`RealtimeTransport`** — community LISTEN/NOTIFY; `ee/` Redis (see [06](06-self-hosting-architecture.md)).
5. **Billing/entitlement hook** — `getEntitlements(scope)`; the gate lives in `ee/`, never in core.

---

## Migration sequence (maps to [06](06-self-hosting-architecture.md) phases)

1. **P0 backstop** — add `org_id` + coarse RLS + `set_config` wrapper as `auth.uid()` RLS is removed.
2. **P2 PDP + community RBAC** — land `lib/authz/` (`can/enforce/bulkCheck/listAccessible`), `PostgresRbacPDP`, the registry + `role/grant/resource_hierarchy` tables, Better Auth `organization` + `@better-auth/sso`. Refactor **every** server action / API route / CLI route onto the PDP (start with `zones.ts` → `listAccessible('view','zone')`). Add the CI guard. Built-in roles only.
3. **Enterprise gating** — dynamic/custom roles, per-Zone grants, audit export (still on `PostgresRbacPDP`) → sellable enterprise RBAC with **no new service**.
4. **OpenFGA** — add `OpenFgaPDP` + the grant→tuple sync + conditions for `destroy`-production, when cross-org sharing / deep graphs / `ListObjects` latency demand it. Binding flip + backfill.

## Exit criteria

- Every data path goes through the PDP; CI guard green (no stray `auth.uid()`/`.eq('user_id')` authz).
- Coarse `org_id` RLS enforced under a connection pooler; adversarial cross-tenant test denied at both the PDP and the DB.
- Community runs with **zero extra services**; `ee/` adds orgs/SSO/OpenFGA behind the seams with no core changes.
- One clean recommendation realized: **one `can()`, two backends, RLS blast wall** → full security + easy scale + tons of fine-grained permissions.
