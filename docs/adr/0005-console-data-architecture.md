<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Console data architecture: reads over typed GET, writes over actions, change hints over one SSE per tab

**Status:** Accepted (maintainer, 2026-10-19 — rulings in §7) · **Revision:** 2 (2026-10-19) · **Issue:** #6113 (seams) · epic #6112 ·
**Measured against:** `origin/dev` @ c05de5316 (main checkout) · **Touches:** ADR 0001 (reuses its
"heartbeat is a route-handler `fetch`, never a server action" rule, `docs/adr/0001-elench-drafts-state-machine.md:35-37`)

> Every repo fact below carries `file:line`; every external fact carries a URL in §9. Anything I could
> not verify against a primary source is marked **UNVERIFIED**. Numbers labelled "measured" are the
> prod measurements handed to this research (2026-10-19), not re-measured here.

---

## 1. Context

### 1.1 Where the console runs

- **A long-lived Node container, not serverless.** `next.config.ts` builds `output: "standalone"`
  (`apps/console/next.config.ts:35`), the image is `apps/console/Dockerfile` (node:22-alpine), and prod
  runs it as `ghcr.io/alethialabs-io/console` in a docker-compose bundle
  (`deploy/prod/docker-compose.prod.yml:15`) on one Hetzner `cx33` box — 4 vCPU / 8 GB
  (`infra/cp-hetzner/variables.tf:116-124`) — behind Caddy and a Cloudflare Tunnel
  (`infra/cp-hetzner/main.tf:101-121`). The Helm chart defaults to `replicas: 1`
  (`deploy/helm/alethia/values.yaml:70`). There is no `vercel.json`.
- The process is already stateful: in-process sweepers and loops (`lib/reconcile/loop.ts:82`,
  `lib/alerts/scheduler.ts:32`, `lib/jobs/recovery.ts:193`, …) and process-wide LISTEN singletons
  (`lib/realtime/index.ts:158-205`). This ADR assumes that stays true; §5 prices the alternative.
- The repo is AGPL with an `ee/` tier, and a community self-host is a product (`Dockerfile.community`).
  **Anything on the hot path must be self-hostable with no third-party SaaS.**

### 1.2 Reads: every client query is a server action

- Every `lib/query/use-*-query.ts` hook uses a `"use server"` function as its `queryFn`, e.g.
  `use-clusters-query.ts:17-21` (`queryFn: () => getClusters()`, `refetchInterval: 5_000`), and
  `lib/query/resource-fetchers.ts:55-84` composes four actions per call. The documented pattern says
  so explicitly: "Server actions in `app/server/actions/*` remain the data layer"
  (`lib/query/README.md:8-11`).
- **Measured (prod, 2026-10-19):** overview hard-load fires 14 POSTs back-to-back (~2.7 s); project
  architecture 15 calls ending at 5.7 s; `settings/general` 9 POSTs (~1.4 s). `~/settings/general`,
  `~/settings/billing` and `~/usage` fetch nothing on the server and load in `useEffect`
  (`app/(private)/[org]/~/settings/general/page.tsx:12-14` renders `<OrgGeneral />` with no prefetch).
- **Why it is serial — confirmed at three primary sources:**
  1. Next.js docs, *Server Actions › Sequential dispatch on the client*: "Next.js dispatches Server
     Actions one at a time per client … do not rely on `Promise.all` to parallelize Server Actions from
     the client. If you need parallel work … use a Route Handler for non-mutation requests." It also
     states "A Server Action runs as a POST request" [N1].
  2. React docs, `'use server'` caveats: "Server Functions are designed for mutations … they are not
     recommended for data fetching. Accordingly, frameworks … typically process one action at a time
     and do not have a way to cache the return value." [R1]
  3. Next source: `dispatchAction` appends any non-navigation action to `actionQueue.last.next` while
     one is pending, and only `runRemainingActions` starts the next
     (`next/dist/client/components/app-router-instance.js:50-74,137-165`); server actions enter that
     queue as `ACTION_SERVER_ACTION` (`app-call-server.js:18`) and are sent `method: 'POST'` with the
     `Next-Action` header (`router-reducer/reducers/server-action-reducer.js:53,75`). Read in the
     locally installed **16.3.4**, not 16.4.0 — the docs page above is dated 2026-10-15 and describes
     the same behaviour, so I treat it as current; the exact line numbers in 16.4.0 are **UNVERIFIED**.
  4. TanStack Query, *Advanced SSR*: "We do **not** recommend using Next.js Server Actions to _fetch_
     data in a `queryFn`" — they run serially and can leave queries stuck pending [T1].
- A consequence nobody has priced: **polls and user writes share that one queue.** `useClustersQuery`
  POSTs every 5 s while the tab is focused (`use-clusters-query.ts:20`); a click that fires a mutation
  waits behind whatever poll is in flight. ADR 0001 already hit this and moved its heartbeat to a route
  handler "so Next's global action queue cannot starve it" (`docs/adr/0001-…:35-37`).
- POSTs are uncacheable by HTTP semantics and by React's statement above; there is no ETag, no
  `Cache-Control`, no CDN path.
- `getQueryClient()` on the server is a fresh client per *call*, not per request
  (`lib/query/client.ts:44-45`), so two components that prefetch in one render do not share a client.
  TanStack's and tRPC's docs both wrap it in React `cache()` [T1][TR1].

### 1.3 Tenancy is decided by the address, mostly

- `app/(private)/[org]/layout.tsx:37-52` calls `resolveOrgScope(org)`, which **writes the session's
  active org on a GET** (`app/server/actions/resolve.ts:79-112`). `next.config.ts:55-64` forbids
  `staleTimes` because a cached segment would not re-run that write (#4089).
- #4147 (same day) made the URL decide the tenant for every request that names an org:
  `currentActor()` prefers `urlScopedOrgId` and falls back to the session **only where the address
  names no org — `/dashboard`, `/cli/login`, `/api/**`, the MCP token path**
  (`lib/authz/guard.ts:27-48`, `lib/authz/org-scope.ts:4-29`). The path reaches server code through
  the `x-alethia-path` header that `proxy.ts:66-67` publishes on every non-static path
  (`proxy.ts:71-75`).
- **Finding (needs a maintainer read, not settled here):** the `next.config.ts` comment says "the next
  write the user makes [is] scoped by that" session write. After #4147 that is true only for org-less
  paths. The residual dependence on the write is therefore smaller than the comment states — but
  anything a client fetches from `/api/**` still falls back to the session. **This decides where the new
  read endpoint is mounted (§2.1).**
- `withActorScope` sets `app.current_owner` / `app.current_org` per transaction for RLS
  (`lib/db/index.ts:116`); OpenFGA checks go through the PDP (`authorizeUserId`, used e.g. in
  `app/api/stream/jobs/[id]/route.ts:36`), and `@openfga/sdk` lives in `ee/package.json:20`.
- Identity resolution is **not memoised per request**: `getOwner`/`getOwnerScope` call
  `auth.api.getSession({ headers })` each time (`lib/auth/owner.ts:17,107`). Every server action POST
  pays session + membership + RLS setup on its own.

### 1.4 Real-time today

- There is already a working, Redis-free LISTEN/NOTIFY fan-out: one dedicated `max: 1` postgres
  connection per channel per process, keyed dispatch to subscribers (`lib/realtime/index.ts:43-111`),
  with an `ee/` Redis swap anticipated (`lib/realtime/index.ts:10-16`).
- Channels wired: `job_logs` (`lib/db/programmables.sql:560`), `support_messages` (`:1751`),
  `runner_wake` (`:60`), `runner_lost` (`:784`), `runner_cancel` (`lib/runners/cancel-signal.ts`).
  **None of them carries a job-status, cluster, runner, alert or environment change to a browser.**
- Browser streams: one `EventSource` per job log (`hooks/use-job-log-stream.ts:26` →
  `app/api/stream/jobs/[id]/route.ts`, backlog via `Last-Event-ID`, 20 s heartbeat at `:142`) and one
  per support case (`components/support/cases/case-detail.tsx:59`). Everything else polls:
  `refetchInterval` in 9 hooks (`use-addons-query.ts:31`, `use-clusters-query.ts:20`,
  `use-environment-status-query.ts:48`, `use-fleet-query.ts:36`, `use-jobs-page-query.ts:27`,
  `use-jobs-query.ts:25,42`, `use-runners-page-query.ts:47`, `use-runners-query.ts:52`,
  `use-support-cases-query.ts:21`) plus `components/design-project/canvas/cards/activity-card.tsx:64`,
  and hand `setInterval`s in UI (`components/connectors/connectors-page.tsx:180`,
  `components/jobs/columns.tsx:37`, `hooks/use-widget-refresh.ts:51`, …).
- **The domain events already exist, one layer up.** Job status transitions arrive at
  `PUT /api/jobs/[id]/status` (`app/api/jobs/[id]/status/route.ts:52`) and are written by the SQL
  function `update_job_status` (`:77-78`), then emitted as org-scoped `system.*` events through
  `emitAlertEventSafe` (`:207-303`) — `emitAlertEvent(orgId, eventKey, context)`
  (`lib/alerts/emit.ts:44`) is called from ~22 files over ~37 `system.*` keys. Cloud asset changes
  arrive at `POST /api/cloud-events/[provider]` (`app/api/cloud-events/[provider]/route.ts:44`).
- `PUT /api/runners/heartbeat` documents the one sharp edge of NOTIFY already: "pg_notify is dropped
  if the runner's SSE was disconnected at notify time" (`app/api/runners/heartbeat/route.ts:49`).

### 1.5 Mutations

- 108 files under `apps/console` + `ee/` contain `"use server"` (67 with it as a top-level directive);
  the brief's "~103" is in that range. No `useActionState` / `useOptimistic` anywhere (0 files);
  `useMutation` in 7 non-test files; 25 `router.refresh()` calls in `components/ app/ hooks/`.
- A result shape already exists in places and is the seed of §2.4: `type ProjectRefusal = { ok: false;
  error: string }` with `{ ok: true; … } | ProjectRefusal` (`app/server/actions/projects.ts:274-287`),
  `SsoActionResult` (`app/server/actions/sso.ts:135-143`).
- `revalidatePath` is used in 6 files; `revalidateTag`/`updateTag`/`unstable_cache` in 0.

### 1.6 Client state

`lib/stores/` holds 23 modules plus the `elench-drafts/` directory (24 units). Six import and call a
server action at runtime — `use-capabilities-store.ts:15`, `use-cloud-provider-store.ts:5,158`,
`use-setup-guide-store.ts:40`, `use-widget-grid-store.ts:92,124`, `use-workspace-store.ts:62,81`,
`elench-drafts/store.ts:33`. The seventh the brief counted, `use-canvas-store.ts:12-13`, imports
**types only**. Filter URL state is `hooks/use-filter-url-sync.ts` (80 lines) over
`lib/query/filter-url-codec.ts` (96 lines), used at 61 sites and gated by `pnpm check:filter-standard`
(`lib/query/README.md:166-173`).

---

## 2. Decision

Five decisions, in dependency order. Each names what enforces it.

### D1. Reads go over typed **GET** procedures, mounted under the org's address — never over server actions

1. **Transport: oRPC** (`@orpc/server` + `@orpc/client` + `@orpc/tanstack-query`, MIT, 1.15.x;
   pin a release ≥ 14 days old). One handler at
   `app/(private)/[org]/~/rpc/[[...rest]]/route.ts` → URL `/{org}/~/rpc/<procedure>`.
   - **Why under `/{org}/~/`:** `proxy.ts` publishes that path, so `currentActor()` resolves the tenant
     from the address with its membership check (`lib/authz/guard.ts:37-48`) and never consults the
     session. A handler under `/api/**` would fall back to the session's org (`org-scope.ts:24-25`) —
     the exact #4089/#4133 shape. Route handlers do not run the `[org]` layout, so **no read ever
     writes the session**. `~` is already the org-level namespace, so it cannot collide with a project
     slug.
   - **GET for every query procedure**, POST stays available for mutations that later want it. oRPC's
     RPC handler accepts only POST/PUT/PATCH/DELETE by default and the client picks the method per
     call (`method` option) [O3]; the server-side GET opt-in plugin's exact name is **UNVERIFIED**
     (I believe `StrictGetMethodPlugin`). GET responses carry `Cache-Control: private, no-store` by
     default; caching is TanStack's job, not the browser's (§D2).
2. **Procedures are thin wrappers over `lib/queries/*`** (which already hold the `query*Page`
   builders and facet passes the filter standard mandates). Each procedure: zod input → `currentActor()`
   → PDP check → `withActorScope` read → narrow DTO. The `"use server"` getters they replace are
   deleted, not kept as a second path.
3. **Client:** `orpc.<proc>.queryOptions({ input })` everywhere; keys come from the procedure path +
   input (`.key()` for partial invalidation [O1]). `lib/query/keys.ts` (`qk`) stays only as the
   topic→key map in D3 and is generated from the router, not hand-written.
4. **SSR: keep the documented RSC-prefetch + `HydrationBoundary` pattern**, with two fixes:
   - prefetch calls the router **in-process** (`createRouterClient` with a context that resolves the
     actor from the same request) — no HTTP hop [O2];
   - `getQueryClient` is wrapped in React `cache()` on the server [T1][TR1], and prefetches are
     `void`ed (not awaited) with the existing pending-dehydration rule (`lib/query/client.ts:31-35`), so
     the page streams instead of blocking on the slowest query.
   - **Not adopted:** `@tanstack/react-query-next-experimental` (`ReactQueryStreamedHydration` +
     `useSuspenseQuery` in client components). TanStack's own docs say it "only flattens waterfalls on
     the initial load" and produces a deep waterfall on navigation [T1].
5. **Pages with zero server fetch** (`settings/general`, `settings/billing`, `usage`) get an RSC
   prefetch in the same PR that moves their reads to D1.

**Enforcement:** a `check:read-transport` script (ratchet, both directions — the allowlist starts at
today's count and may only shrink) fails on any `queryFn` / `queryOptions` that resolves to an
import from `app/server/actions/**`, and on any new `"use server"` export whose name starts with
`get|list|fetch|load`.

### D2. Next 16 `cacheComponents` / `use cache` / PPR: **not now; re-decide after D1 + D3 and one precondition**

- **What it would give.** `cacheComponents: true` makes data dynamic-by-default, enables `use cache` +
  `cacheLife` + `cacheTag`, makes PPR the default (static shell + streamed holes), and keeps recently
  visited routes mounted under React `<Activity mode="hidden">` [N2][N4]. `updateTag` gives
  read-your-own-writes from a Server Action; `revalidateTag(tag, profile)` is SWR and works from route
  handlers [N1][N4].
- **Why not now:**
  1. *Almost nothing here is shareable.* Every `[org]` route reads the session, so under Cache
     Components it lives behind `<Suspense>` and streams on every navigation [N3]. The static shell
     would be the chrome — which itself depends on the org (`AppShell` takes `selfRunners`,
     `pageOrgId`, `layout.tsx:64-68`).
  2. *The cache cannot hear most writers.* Job status is written by the runner through SQL functions
     (`update_job_status`, `insert_job_log`) and cloud state by `/api/cloud-events`. `updateTag` "can
     only be called from a Server Action" [N4]; anything the runner writes would need the D3 bus to call
     `revalidateTag` from a non-request context — **UNVERIFIED** that `revalidateTag` works outside a
     request scope.
  3. *Tenancy in the key.* A plain `use cache` function cannot read `cookies()`/`headers()` [N3], so
     the actor must be passed as an argument; arguments and tags are stored **in plain text** in the
     cache key [N3], and the DB read inside must re-apply RLS from that argument. Doable, but it is a
     second authorization path to keep in lockstep with `withActorScope`.
  4. *#4089 compatibility.* `use cache: private` defaults to a 5-minute client `stale` and produces a
     "per-session App Shell … prefetched and cached per session" [N3]; with `<Activity>` the previous
     route stays mounted. A cached or restored `[org]` segment does not re-run `resolveOrgScope`, which
     is precisely what `next.config.ts:55-64` forbids. Note also that `staleTimes` docs say back/forward
     is served from the client cache regardless [N5] — so the layout write is *already* skipped on
     Back today; #4147's address-decides rule is what makes that harmless.
  5. *Migration cost.* 8 files export `dynamic`, 10 export `runtime`; both error under the flag
     [N4]. Activity changes dialog/form semantics app-wide [N4].
- **Precondition to re-open:** remove the session as a tenancy input altogether — `resolveOrgScope`
  stops writing on GET; the org switcher writes the *preference* explicitly; org-less paths
  (`/dashboard`, `/api/**`) take an explicit org (header or path) the way the CLI does
  (`X-Alethia-Org`, `lib/authz/guard.ts:140-160`). Then `staleTimes`, `<Activity>` and PPR are all
  safe by construction instead of by comment.
- **What to pilot after that** (cheap, high-hit-rate, tenant-agnostic): the plan catalog, alert event
  catalog, runner release list, provider capability catalogs — `use cache` + `cacheLife('hours')` +
  `cacheTag`, in-memory default (fine on one container [N4]).

### D3. Real-time: Postgres NOTIFY → in-process fan-out → **one multiplexed SSE stream per tab** carrying **invalidation hints**

1. **Producer — triggers, not app code.** A new `notify_change()` trigger function on the tables
   whose changes the UI shows: `jobs` (status), `project_cluster`, `runners`, `alert_deliveries`,
   environment status, `support_cases`, addons. It does
   `pg_notify('alethia_change', json_build_object('o', org_id, 't', topic, 'id', id, 'p', project_id))`
   — ids only, far under the 8000-byte limit [P1]. Triggers catch every writer, including the
   runner's SQL RPCs that never pass through Next. (`emitAlertEvent` is the wrong seam: it no-ops
   when an org has no matching alert rule, `lib/alerts/emit.ts:49-50`.)
2. **Transport — reuse `PgListenTransport`** (`lib/realtime/index.ts:48`) with a new channel keyed by
   `org_id`. One LISTEN connection per process regardless of user count.
3. **Endpoint — `GET /{org}/~/events`** (same address rule as D1). Authorises once at connect
   (`currentActor()` + membership), subscribes to that org's key, sends `id:`-tagged events, 20 s
   heartbeat comments (below Cloudflare's 125 s proxy read timeout [C1]). Per-project hints are
   filtered by a memoised PDP `view` check (TTL ≤ 60 s) so a member never learns ids of projects they
   cannot see.
4. **One stream per tab.** All org topics share it. The per-job log stream stays separate (it pushes
   data, is append-only, and opens only on a job page). Support-case streams fold into it later.
5. **Client — invalidate, don't push.** `useOrgEvents()` mounted once in `AppShell` maps
   `topic(+id)` → oRPC keys and calls `queryClient.invalidateQueries({ queryKey })`, which refetches
   **only active (observed) queries** by default [T2], through D1, i.e. through RLS + OpenFGA again.
   Coalesce per key on a 250–500 ms window (`invalidateQueries` cancels an in-flight refetch by default
   [T2], so an uncoalesced burst thrashes).
6. **Gap handling.** NOTIFY is fire-and-forget to *current* listeners [P1]. So: on every SSE
   (re)connect the client invalidates all active org queries; on a server-side LISTEN reconnect the
   process emits a `resync` event to every stream. No event log, no replay table — the read path *is*
   the replay.
7. **Polling is deleted, not reduced,** for every topic D3 covers; `staleTime` for those queries rises
   to minutes; `refetchOnWindowFocus` stays as the belt-and-braces.

**Why invalidate-by-key and not push-the-data:** authorization stays in exactly one place (the read
procedure), payloads stay tiny, per-subscriber row filtering (the thing that makes Supabase's
Postgres Changes single-threaded and RLS-checked per subscriber [S1]) never exists, and a dropped event
costs one refetch rather than a wrong cache. The price is one GET per active tab per relevant change —
priced in §5.

### D4. One mutation contract: server actions → `ActionResult<T>` → `useActionMutation`

1. **Transport stays server actions** for writes. They keep Next's CSRF origin check, encrypted IDs
   and body cap [N1]; serial dispatch is *correct* for a user's own writes; and once D1 removes reads
   from the queue, writes no longer wait behind polls. Not route handlers: a POST handler would need
   its own origin check and buys nothing for writes.
2. **Not `useActionState`/`useOptimistic`.** The house rule is `react-hook-form` for every form
   (CLAUDE.md §6); `useActionState` is built around `<form action>`/`FormData` and its result is local
   to one component, while the data the user is looking at lives in the TanStack cache. `useOptimistic`
   reverts when its transition ends and cannot roll back a *shared* cache entry. Both are fine for a
   one-off toggle; neither is the contract.
3. **Server side — `defineAction`:**

   ```ts
   export type ActionError =
     | { kind: "validation"; message: string; fields: FieldErrors }   // zod flatten
     | { kind: "unauthenticated" }                                     // → /login
     | { kind: "forbidden"; message: string }                          // PDP deny
     | { kind: "not-found"; message: string }
     | { kind: "conflict"; message: string }                           // CAS / unique / state machine
     | { kind: "entitlement"; message: string; feature: string }       // plan gate → upgrade sheet
     | { kind: "unexpected"; ref: string };                            // logged; no internals leaked
   export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError };
   ```

   `defineAction({ input: zodSchema, run })` parses input, resolves the actor, runs, maps typed
   domain errors (`ForbiddenError`, `NotFoundError`, `ConflictError`, `EntitlementError`) to kinds,
   **re-throws Next's control-flow errors** (`redirect`, `notFound`) untouched, and turns anything else
   into `unexpected` with a log reference. `FieldErrors` is a named interface, not
   `Record<string, unknown>`. The existing `{ ok: false; error: string }` refusals
   (`projects.ts:274`) map onto `conflict`/`forbidden` mechanically.
4. **Client side — `useActionMutation(action, { invalidates, optimistic? })`** = `useMutation` whose
   `mutationFn` throws an `ActionFailure` on `ok: false` (so TanStack's `onError` and rollback run),
   `onMutate` snapshots + applies an optional optimistic patch to named keys, `onError` restores the
   snapshot, `onSettled` invalidates the declared keys. The acting tab invalidates immediately
   (read-your-own-writes); other tabs and users get the D3 hint.
5. **Toast policy** (one place, overridable per call): `validation` → inline field errors via RHF
   `setError`, no toast · `unauthenticated` → redirect · `forbidden` / `not-found` / `conflict` → error
   toast with the server's message · `entitlement` → open the existing upgrade sheet
   (`UpgradeSheetProvider`, `layout.tsx:64`) · `unexpected` → generic toast + `ref`. Success toast only
   when the result is not otherwise visible (queued jobs, background ops, destructive deletes).
6. **`router.refresh()`** survives only where an RSC renders the rows itself (the blessed URL→RSC
   overview variant, `lib/query/README.md:175-185`); there the action calls `refresh()` server-side so
   the new payload rides the same response [N1]. Everywhere else it becomes key invalidation.

**Enforcement:** a ratchet on (a) `"use server"` exports that are not `defineAction` and (b)
`router.refresh(` call sites; both may only fall.

### D5. Client state: Query owns server state; Zustand keeps UI state; URL state stays on the house codec

| Store | Verdict | Becomes |
|---|---|---|
| `use-workspace-store` (`getWorkspaceContext`, entitlements, `setActiveOrganization`) | **server state** | a D1 query hydrated by the `[org]` layout; switching org = navigation (+ explicit preference write) |
| `use-capabilities-store` (6 h TTL cache over `getIdentityCapabilities`) | **server state** | query, `staleTime: 6h` — the store re-implements TanStack |
| `use-cloud-provider-store` (inventory fetch + TTL) | **split** | inventory → query; selected provider/identity stays Zustand |
| `use-setup-guide-store` (`getGettingStartedState`) | **split** | state → query; dismissed/collapsed flag stays persisted UI |
| `use-widget-grid-store` (`listThreadWidgets`, `pinWidget`) | **server state** | query + `useActionMutation` with optimistic position patch |
| `elench-drafts/*` | **out of scope** | governed by ADR 0001's state machine; do not touch |
| `use-canvas-store` (1375 lines, design graph) | UI / document state | keep; its env status already comes from `use-environment-status-query` |
| `use-projects-store` (favourite ids) | UI preference | keep (server-side only if cross-device favourites are wanted) |
| `use-notifications-store` (read ids, persisted) | UI preference | keep; source lists become D3-driven queries |
| `create-filter-store` + 7 `*-filters` stores | UI state, URL-mirrored | keep (filter standard) |
| `use-alerts-section`, `use-artifact-store`, `use-auth-prefs-store`, `use-command-palette`, `use-elench-store`, `use-inspector-prefs-store`, `use-sidebar-store` | UI state | keep |

**nuqs: rejected for now.** nuqs 2.x would give typed parsers shared between client hooks and RSC
(`createSearchParamsCache`/`createLoader`) [Q1] — but the house codec already shares one decoder
between `useFilterUrlSync` and the RSC prefetch (`filter-url-codec.ts:4-11`), carries the
sessionStorage-persistence and `urlRead`-debounce semantics #5861 needed, and is gated by
`check:filter-standard` F1–F6 with a both-directions debt ledger. Swapping it re-opens a closed,
enforced standard for type-safety we can get by giving the codec typed parser objects. Re-decide only
if non-filter URL state (tabs, selected row, open dialog) starts proliferating — and then extend the
codec rather than run two URL mechanisms.

---

## 3. Consequences

**Better**
- Overview/architecture/settings reads go parallel: 14 serial POSTs become ≤ 14 concurrent GETs over
  HTTP/2, and on hard load they are mostly prefetched in-process with zero client round-trips. Expected
  overview data time ≈ the slowest single read, not the sum (**UNVERIFIED** — re-measure after the
  pilot; the target is the 2.7 s figure dropping below 1 s).
- User writes stop queueing behind polls.
- Idle dashboards cost ~nothing: the unconditional 5 s cluster poll and the conditional job/runner/
  env polls disappear for covered topics.
- One tenancy rule for every client read: the address. No read can move the session.
- One error shape the UI can switch on; toasts stop being per-file decisions.

**Worse / new obligations**
- A new dependency family (oRPC) in the open-core build. Mitigated: procedures are plain functions
  over `lib/queries/*`; the oRPC layer is ~one handler + one client file and could be swapped for raw
  route handlers without touching procedures.
- Every trigger-covered table now has a NOTIFY on write. NOTIFY serialises committing notifiers on a
  global queue lock — **UNVERIFIED** from the Postgres docs page (it says nothing about throughput
  [P1]); at this write volume it is not a concern, but it is the first thing to measure if the runner
  write rate grows 100×.
- One long-lived connection per open tab on the console process (priced in §5); `ulimit -n` and the
  Caddy/Cloudflare path must be confirmed to stream (Caddy flushes `text/event-stream` immediately —
  **UNVERIFIED** for the deployed Caddyfile).
- Multi-replica works unchanged (each replica LISTENs), but a hint is generated per replica that holds
  the org's streams — fine; no cross-replica bus needed until a non-Postgres producer appears.
- Plain HTTP/1.1 self-hosts (no TLS → no HTTP/2) hit the browser's 6-connections-per-origin limit at
  ~5 tabs. One stream per tab (not per resource) is what keeps that tolerable; a `BroadcastChannel`
  leader tab is the follow-up if it bites.

---

## 4. Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **Keep server actions as `queryFn`, batch more into each action** | Fights the framework: Next, React and TanStack all say don't [N1][R1][T1]; still POST, still queued with writes, still uncacheable. Batching only moves the waterfall into one fat action per page. |
| **Plain GET route handlers + hand-written fetchers** | Correct transport, but re-creates typing, key factories, input parsing and error mapping per endpoint; `qk` is already drifting by hand. Kept as the fallback if oRPC is vetoed — D1's procedures are written so they can be mounted this way. |
| **tRPC v11** | Equally viable (`createTRPCOptionsProxy` for RSC prefetch, `queryOptions`, SSE subscriptions with `tracked()` resume [TR1][TR2]). oRPC chosen for its contract-first/OpenAPI path — the CLI already has a wire-locked REST surface (`app/api/cli/**`) that could later be generated from the same contracts — and Standard-Schema/zod 4 inputs. A coin-flip-grade preference; **not** a correctness argument. |
| **`@tanstack/react-query-next-experimental` streaming without prefetch** | Waterfalls on every client navigation [T1]. |
| **`cacheComponents` now** | §D2: little shareable data, writers outside Next, #4089, migration of 18 segment-config files, Activity semantics. |
| **`staleTimes.dynamic > 0`** | Same #4089 hazard, for a smaller win than D1 gives. |
| **ElectricSQL shapes** | Needs logical replication + another service; shapes are single-table with restricted WHERE and no include trees [E2]; auth lives in a proxy-set WHERE clause, not RLS/OpenFGA [E1] — a second authorization model to keep identical to the first. CDN cacheability is its headline benefit and is worthless for per-tenant, per-user data behind `Vary: Cookie` [E1]. Revisit only for a genuinely shared, read-heavy dataset. |
| **Zero (Rocicorp)** | Replaces the data layer: a `zero-cache` SQLite replica fed by logical replication, permissions in custom query/mutator endpoints [Z1]. Large operational and conceptual buy-in for a dashboard whose hard problem is authorization, not offline/latency. |
| **Replicache** | Archived 2026-06-10 [Z2]. |
| **Supabase Realtime (self-hosted)** | Postgres Changes authorises every event per subscriber on a single thread; docs recommend Broadcast above ~3 000 subscribers [S1] — at which point it is a pub/sub we already have in `lib/realtime`. Adds an Elixir service. |
| **Ably / Pusher** | Not self-hostable → cannot be the community edition's hot path (AGPL product). Price is fine at small scale (§5) — acceptable later as an **`ee/` transport adapter** behind `ChannelTransport`, never as the only path. |
| **WebSockets instead of SSE** | Server→client only is all we need; SSE reconnects with `Last-Event-ID` natively, passes Cloudflare/Caddy as plain HTTP, and tRPC's own docs recommend SSE over WS for subscriptions [TR2]. |
| **Push full rows over the stream** | Needs per-subscriber authorization of row data and per-topic cache patching; breaks on the 8 KB payload cap [P1]; a missed event leaves a wrong cache. Kept only for the append-only job log. |
| **One `EventSource` per resource** | 6-connection cap on HTTP/1.1 self-hosts; N LISTEN subscriptions per tab. |
| **`useActionState` / `useOptimistic` as the contract** | §D4.2. |
| **nuqs** | §D5. |

---

## 5. Cost model for real-time

### 5.1 Assumptions (all stated, the per-connection figure is the one to measure first)

- **S** = concurrent open console tabs. Steady-state business usage: 10 h/day × 22 days = **220 h/month**
  per tab; worst case 24/7 = **730 h/month**.
- Memory per idle SSE stream in Node (socket buffers + `ReadableStream` + closures + a `Set` entry):
  **assume 64 KB** — **UNVERIFIED**; measure with 1 000 synthetic streams against a standalone build
  before relying on any row below.
- Heartbeat: 1 write / 20 s / stream (existing cadence). Server-action poll cost today: session read +
  membership + RLS tx + query ≈ **10 ms CPU** — **UNVERIFIED**, derived from nothing better than the
  ~190 ms/POST wall time implied by the 14 POSTs / 2.7 s measurement (most of which is network + queue).
- Change rate: **R** relevant changes / org / minute while jobs run; each produces ≤ 1 GET per tab that
  currently observes an affected query.

### 5.2 Polling today vs D3, on the existing container

| S (concurrent tabs) | Polling: clusters alone (1 POST / 5 s / focused tab) | ≈ CPU @10 ms | D3 idle memory (S × 64 KB) | D3 heartbeat writes/s | D3 cost per change |
|---|---|---|---|---|---|
| 100 | 20 req/s | 0.2 core | 6.4 MB | 5 | ≤ 100 GETs per org-wide change, coalesced |
| 1 000 | 200 req/s | 2 cores — **half the cx33** | 64 MB | 50 | per org, so ≈ tabs-in-that-org |
| 10 000 | 2 000 req/s | 20 cores — **impossible on one box** | 640 MB | 500 | same |

Polling scales with **time × tabs**; D3 scales with **changes × watchers**. On a flat-priced container
D3's marginal cost is memory headroom and file descriptors, i.e. ~€0 until ~10k streams, then one more
small box running the same image as an events-only replica (Hetzner `cx`-class box: a few €/month —
exact current price **UNVERIFIED**).

### 5.3 What the same load would cost elsewhere (for the record)

- **Vercel Fluid compute** (if the console ever moved): memory is billed for the instance's whole
  lifetime while any request — including an idle stream — is in flight; fra1 = $0.0152 / GB-h, Active
  CPU $0.184 / h, invocations $0.60 / M [V1]. A 1 GB instance kept alive 24/7 by streams = 730 GB-h ≈
  **$11 / month per GB**; at S = 10 000 with ~1 000 streams per 1 GB instance (**UNVERIFIED**
  concurrency) ≈ **$111 / month** + reconnect invocations (function max duration forces periodic
  reconnects; exact limit **UNVERIFIED**). Tolerable, but the LISTEN-per-instance model and the
  in-process sweepers do not survive instance pausing — the bigger cost is architectural.
- **Ably**: Standard $29 / month (10k peak connections) + $1.00 / M connection-minutes + $2.50 / M
  messages [A1]. S = 1 000 × 220 h = 13.2 M conn-min ≈ **$13 + $29**; S = 10 000 × 730 h = 438 M
  conn-min ≈ **$438 + $29 + messages**.
- **Pusher Channels**: tiers by concurrent connections — 2 000 = $99 / month, 10 000 = $499 / month,
  30 000 = $1 199 / month [PU1].
- **Conclusion:** self-hosted SSE on the existing container is the cheapest option at every scale this
  product will see in the next year, and the only one that ships in the community edition.

---

## 6. Migration order

Each step unblocks the next; nothing later depends on anything earlier being *finished*, only *landed*.

1. **Read-layer foundation (one PR, no page changes).** oRPC router + `/{org}/~/rpc` handler with
   GET enabled; `createRouterClient` server caller; `cache()`-wrapped `getQueryClient`; the
   `check:read-transport` ratchet seeded at today's count. Proves tenancy: a test that a GET to
   `/{orgA}/~/rpc/…` by a non-member 404s and never touches `session.active_organization_id`.
2. **Pilot page: overview** (`/{org}`, worst measured: 14 POSTs). Move its reads to procedures,
   RSC-prefetch them, re-measure. Then **project architecture / canvas** (15 calls, 5.7 s) — which also
   means `resource-fetchers.ts` and `use-environment-status-query`.
3. **Pages that fetch nothing on the server:** `settings/general` (9 POSTs), `settings/billing`,
   `usage` — procedures + RSC prefetch, `useEffect` loaders deleted.
4. **Realtime bus (D3)**, independent of 2–3 but more useful after them: `notify_change()` trigger +
   migration via `scripts/db-generate.sh` on a freshly rebased branch (CLAUDE.md §5); `/{org}/~/events`;
   `useOrgEvents()` in `AppShell`. Topics in this order: **jobs** (status) → **clusters** (deletes the
   unconditional 5 s poll) → **runners/fleet** → **environment status** (canvas) → **alerts deliveries**
   → **support cases** (then fold the per-case `EventSource`). Each topic PR deletes its
   `refetchInterval`.
5. **Mutation contract (D4):** `ActionResult`/`defineAction`/`useActionMutation` + toast policy + the
   two ratchets. Convert modules touched by steps 2–4 first; the rest opportunistically.
6. **Stores → queries (D5):** workspace → capabilities → cloud-provider inventory → setup-guide →
   widget-grid.
7. **Remaining list pages** (jobs, runners, clusters, alerts lists, settings/*, connectors, evidence,
   support) move their `queryFn`s to procedures; the ratchet reaches zero; `README.md` is rewritten
   around D1/D3/D4.
8. **Session-tenancy removal** (D2 precondition), then **re-open D2** with the catalog pilot.

---

## 7. Maintainer rulings (2026-10-19)

- **Q1 → oRPC.**
- **Q2 → yes, identical.** The personal scope is served at `/~/~/rpc` and `/~/~/events` by the same
  handlers; `urlScopedOrgId` already resolves `PERSONAL_ORG_SLUG`. A procedure that has no meaning in
  personal scope refuses with an `entitlement`/`forbidden` result, never with empty data.
- **Q3 → real-time is the DEFAULT, not an optimisation.** Every entity that can change without the
  viewer's own action — project, environment, cluster, job, runner, add-on, alert delivery, support
  case, canvas node status, usage counters — is subscribed through D3. Polling (`refetchInterval`,
  `setInterval`) is banned for those topics and a ratchet enforces it. Hints are filtered per project
  through the PDP (the Q3 default). The product rule behind it: the user never reloads a page to see
  the truth, and never acts on a screen that is stale.
- **Q4 → delegated.** Verified as part of the seams unit: the tenancy test asserts that no read path
  consults `session.active_organization_id` where the address names an org; the `next.config.ts`
  comment is rewritten to what that test proves.
- **Q5 → yes.** Arm 2 of `currentActor()` applies only when the edition is community by
  configuration; an enterprise build whose module failed to register throws.

## 7a. Open questions (as originally posed)

- Q1. oRPC vs tRPC (§4) — preference, not correctness. Default: oRPC.
- Q2. Does `/{org}/~/rpc` need to serve the personal scope `~/~/rpc` identically? (Assumed yes —
  `urlScopedOrgId` already handles `PERSONAL_ORG_SLUG`, `org-scope.ts:78,98`.)
- Q3. Is per-project PDP filtering of hints (D3.3) required, or is "org members may see that *some*
  project changed" acceptable? Default: filter.
- Q4. Re-verify the `next.config.ts:55-64` comment against #4147 — is the session write still
  load-bearing for anything but org-less paths?
- Q5. (Added after the sandbox run, F049.) D1 relies on `currentActor()` resolving the URL's org.
  On the 2026-10-19 sandbox (enterprise edition, dev server) every server action on `/demo-acme`
  resolved the user's PERSONAL scope instead — `listDrafts` returned `orgId == user_id`,
  `getCollaborationAccess` said `canInvite: false`, `getOrgSettings` returned `null` — while the RSC
  render showed Acme. `currentActor()`'s arm 2 (`lib/authz/guard.ts`) accepts a collapse to personal
  scope in every edition, and `loadEnterprise()` (`lib/enterprise.ts:267-330`) degrades to community
  silently when `ALETHIA_EDITION` is unset and `@alethia/ee` fails to load. Proposed: arm 2 applies
  only when `getEnterprise()` is null BY EDITION (`ALETHIA_EDITION=community`), and an enterprise
  build whose module failed to register throws. The D1 tenancy test (§6 step 1) must cover it.

## 8. What this ADR does not decide

Chat/agent streaming (`ai` SDK routes, ADR 0003), the job-log stream's internals, the admin app's
realtime (`apps/admin/lib/realtime.ts`), and CLI wire contracts.

---

## 9. Sources

**Next.js / React**
- [N1] Next.js, *Server Actions and Mutations* (sequential dispatch, POST, single-roundtrip
  revalidation, `updateTag`/`revalidateTag`/`refresh`, security) — https://nextjs.org/docs/app/guides/server-actions (lastUpdated 2026-10-15)
- [N2] Next.js, `cacheComponents` (PPR default, `<Activity>` navigation) — https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents
- [N3] Next.js, *Authentication with Cache Components* (`use cache: private`, plain-text keys, per-session App Shell, 5-min default stale) — https://nextjs.org/docs/app/guides/authentication-with-cache-components
- [N4] Next.js, *Migrating to Cache Components* (`dynamic`/`runtime` errors, `updateTag` Server-Action-only, in-memory default, Activity state) — https://nextjs.org/docs/app/guides/migrating-to-cache-components
- [N5] Next.js, `staleTimes` (dynamic default 0, back/forward cache) — https://nextjs.org/docs/app/api-reference/config/next-config-js/staleTimes
- [R1] React, `'use server'` caveats — https://react.dev/reference/rsc/use-server
- Next source (installed 16.3.4): `next/dist/client/components/app-router-instance.js:50-165`,
  `next/dist/client/app-call-server.js:18`,
  `next/dist/client/components/router-reducer/reducers/server-action-reducer.js:53,75`

**TanStack / RPC**
- [T1] TanStack Query, *Advanced Server Rendering* — https://tanstack.com/query/latest/docs/framework/react/guides/advanced-ssr
- [T2] TanStack Query, `QueryClient` reference (`invalidateQueries` refetchType default `'active'`, `cancelRefetch`) — https://tanstack.com/query/latest/docs/reference/QueryClient
- [O1] oRPC, TanStack Query integration — https://orpc.dev/docs/integrations/tanstack-query
- [O2] oRPC, Next.js adapter (route handler, `createRouterClient` for SSR) — https://orpc.dev/docs/adapters/next
- [O3] oRPC, RPCLink (`method` per call; handlers accept POST/PUT/PATCH/DELETE by default) — https://orpc.dev/docs/client/rpc-link
- [TR1] tRPC, TanStack React Query › Server Components — https://trpc.io/docs/client/tanstack-react-query/server-components
- [TR2] tRPC, Subscriptions (SSE recommended, `tracked()` resume) — https://trpc.io/docs/server/subscriptions
- npm registry (2026-10-19): `@orpc/server` 1.15.7 MIT; `@trpc/server` 11.19.0 MIT; `nuqs` 2.10.2 MIT; `@electric-sql/client` 1.5.28 Apache-2.0; `@rocicorp/zero` 1.11.0 Apache-2.0
- [Q1] nuqs, server-side parsing — https://nuqs.dev/docs/server-side

**Real-time**
- [P1] PostgreSQL, `NOTIFY` (8000-byte payload, 8 GB queue, delivery only on commit, ordering) — https://www.postgresql.org/docs/current/sql-notify.html
- [E1] Electric, *Auth* guide — https://electric.ax/docs/guides/auth
- [E2] Electric, *Shapes* guide — https://electric.ax/docs/guides/shapes
- [Z1] Zero docs index — https://zero.rocicorp.dev/llms.txt
- [Z2] Replicache repository (archived 2026-06-10) — https://github.com/rocicorp/replicache
- [S1] Supabase, *Postgres Changes* (per-subscriber authorization, single thread, Broadcast above ~3 000) — https://supabase.com/docs/guides/realtime/postgres-changes
- [C1] Cloudflare, connection limits (Proxy Read Timeout 125 s, Idle 900 s) — https://developers.cloudflare.com/fundamentals/reference/connection-limits/

**Pricing**
- [V1] Vercel, Fluid compute pricing — https://vercel.com/docs/functions/usage-and-pricing
- [A1] Ably pricing — https://ably.com/pricing
- [PU1] Pusher Channels pricing — https://pusher.com/channels/pricing/

**Repo** (all at c05de5316): `apps/console/next.config.ts:35,55-65`; `apps/console/lib/query/{README.md,client.ts,resource-fetchers.ts,use-clusters-query.ts,filter-url-codec.ts}`;
`apps/console/app/(private)/[org]/layout.tsx:37-68`; `apps/console/app/server/actions/resolve.ts:79-112`;
`apps/console/lib/authz/{guard.ts:27-48,140-160, org-scope.ts:4-29, org-path.ts:58-100}`; `apps/console/proxy.ts:60-75`;
`apps/console/lib/realtime/index.ts`; `apps/console/app/api/stream/jobs/[id]/route.ts`; `apps/console/lib/db/programmables.sql:60,560,784,1751`;
`apps/console/app/api/jobs/[id]/status/route.ts:52-303`; `apps/console/lib/alerts/emit.ts:44-50`; `apps/console/lib/db/index.ts:116`;
`apps/console/app/server/actions/projects.ts:274-287`; `apps/console/lib/stores/*`; `deploy/prod/docker-compose.prod.yml:15`;
`infra/cp-hetzner/variables.tf:116-124`; `deploy/helm/alethia/values.yaml:70`; `docs/adr/0001-elench-drafts-state-machine.md:35-37`.


---

## 10. Revisions after the adversarial review (2026-10-19)

A hostile review of revision 2 (14 risks; the full text lives with the hunt's working files) changed
the decisions below. Where this section and the sections above disagree, **this section wins**.

**D1 — reads**
- oRPC 1.x enables `StrictGetMethodPlugin` by default: every query procedure declares
  `.route({ method: "GET" })` (`lib/rpc/base.ts`). The router carries **reads only** — oRPC 1.x has
  no CSRF protection for non-GET procedures. `@orpc/*` imports are confined to `lib/rpc/`. Pinned at
  1.15.4 (published 2026-09-23); v2 is in beta and the project has effectively one maintainer, so
  procedures stay plain functions that a raw route handler could mount instead.
- **The tenant is not in an oRPC key** (`[path, { input, type }]`). The browser keeps **one
  QueryClient per org segment** (`lib/query/client.ts`, `app/providers.tsx`) and computes the read
  URL per call from the current segment (`lib/rpc/client.ts`), so a client-side org switch can never
  render or request another org's rows (R1).
- The actor is resolved in the route handler **before** oRPC runs and bound with `runWithActor`
  (`app/(private)/[org]/~/rpc/[[...rest]]/route.ts`): a non-member is a 404, not oRPC's 500 for
  `notFound()` (R4), and readers that call `authorize()` reuse the actor.
- D1.2's "thin wrappers over `lib/queries/*`" holds for a minority of reads: ~135 read-shaped exports
  live in ~53 `app/server/actions/*` files. Each domain lane **moves** its getter bodies into its own
  procedure file (`lib/rpc/procedures/<domain>.ts`, pre-created by #6113); it does not wrap actions.
- A now-relative range travels as its **preset**, resolved on the server at read time, so the server's
  prefetch key and the client's key are identical (the jobs slice found a millisecond drift that made
  every first paint miss).
- A typed read-side result for expected refusals (`ReadResult<T>`: forbidden / entitlement /
  not-found) is still owed; until it lands, error ≠ empty cannot be asserted end to end (R11).

**D3 — real-time** (built by #6115; this is the contract it builds to)
- Triggers fire only on the columns the UI shows, with `WHEN (OLD.x IS DISTINCT FROM NEW.x)`: runner
  heartbeats, claims and pings SET `status` and must emit **zero** hints (R5). NOTIFY takes a
  database-wide lock at commit (verified), so a commit-latency load test is part of the unit.
- Routing covers managed runners (`org_id IS NULL`), fleet tables (no `org_id`) and jobs stamped
  `org_id = user_id` inside a hosted org (R6).
- "Live by default" needs a designed failure mode (R7): a visible connection-state indicator, ONE
  sanctioned fallback poll used only while the stream is down, re-authorisation every 60 s, a boot-time
  LISTEN self-test (a transaction pooler silently breaks LISTEN), and `resync` on reconnect.
- One stream per **browser**, not per tab: a leader tab (Web Locks + BroadcastChannel) in v1. On plain
  HTTP/1.1 the six-connection cap otherwise hangs every request in every tab past ~5 tabs (R8).
- Herd control (R9): hidden tabs mark stale (`refetchType: 'none'`), invalidations are jittered and
  coalesced, and a server boot id stops a deploy from refetching everything everywhere.
- The events route sends `Cache-Control: no-transform` and `X-Accel-Buffering: no`.

**D4 — writes**
- Actions that call slow external services (the purchase flow holds a tab's action queue ~40 s)
  enqueue a job or become route handlers; `onSettled` invalidation goes through the coalescer.

**Q4 — the tenancy proof** is an enumeration over the router, not one sample: every procedure is
reachable only through the handler that resolves the address first (`tests/lib/rpc/route.test.ts`).

**Q5 — edition.** Landed separately in #6149: the enterprise load records its outcome, a failed
load rethrows on every call, and `currentActor()` serves the personal scope for an org address only
in the community edition by configuration.

**Order.** No lane fans out before the jobs slice (#6113) and the bus with the jobs topic (#6115) are
measured; every page lane copies that slice.
