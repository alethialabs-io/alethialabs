<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Console data fetching (TanStack Query)

> **Superseded in part by [ADR 0005](../../../../docs/adr/0005-console-data-architecture.md)
> (#6113).** Reads now travel over the GET read router (`lib/rpc`, oRPC) — **never** as a server
> action in a `queryFn`, which Next dispatches one at a time (F001). New reads:
> `useQuery(orpc.<domain>.<proc>.queryOptions({ input }))` in the browser and
> `getQueryClient().prefetchQuery(serverOrpc().<domain>.<proc>.queryOptions({ input }))` in the
> server component, with the SAME input. Writes stay server actions, defined with `defineAction`
> and called through `useActionMutation` (`lib/actions/`). The browser keeps one QueryClient per
> org. `pnpm -F console check:read-transport` ratchets the old pattern down. The jobs page
> (`app/(private)/[org]/~/jobs/`) is the reference implementation. The sections below describe the
> pattern being migrated away from.

The console fetches server data through **TanStack Query v5**, with server-side
prefetch + client hydration so list pages render with data on first paint (no
post-hydration `useEffect` waterfall). Server actions in `app/server/actions/*` remain
the data layer; query hooks just wrap them and add caching, dedup and invalidation.

## The pieces

| File | Role |
| --- | --- |
| `lib/query/client.ts` | `getQueryClient(scope)` — request-scoped (and `cache()`-shared) on the server, **one per org segment** in the browser. |
| `app/providers.tsx` | `<QueryClientProvider>` (+ dev devtools), mounted in `app/layout.tsx`. |
| `lib/query/keys.ts` | `qk` typed key factory. Keys are **org-scoped** so switching orgs never serves another org's cache. |
| `lib/query/use-*-query.ts` | Per-resource hooks: a `useXQuery()` read + `useXMutation()` writes. |
| `lib/seo/page-metadata.ts` | `pageMetadata({title, description})` → `Metadata` with OG/Twitter. The `(private)` group layout sets `robots: noindex` (authed pages aren't crawlable); pages inherit it and only add title + OG (for link unfurls). |

## The pattern (copy this for a new list page)

**1. Query hook** (`lib/query/use-foo-query.ts`, `"use client"`):

```ts
export function useFooQuery() {
  const { org } = useParams<{ org: string }>();
  return useQuery({
    queryKey: qk.foo(org),
    queryFn: () => getFoo(),               // a "use server" action
    // No refetchInterval: add qk.foo's prefix to the topic in lib/query/topics.ts instead.
  });
}

export function useUpdateFoo() {
  const qc = useQueryClient();
  const { org } = useParams<{ org: string }>();
  return useMutation({
    mutationFn: (input) => updateFoo(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.foo(org) }),
  });
}
```

**2. Server page** (`app/(private)/[org]/~/foo/page.tsx`, RSC) — prefetch + hydrate +
metadata:

```tsx
export const metadata = pageMetadata({ title: "Foo", description: "…" });

export default async function FooRoute({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const qc = getQueryClient();
  await qc.prefetchQuery({ queryKey: qk.foo(org), queryFn: () => getFoo() });
  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <FooClient />
    </HydrationBoundary>
  );
}
```

**3. Client component** (`foo-client.tsx`) calls `useFooQuery()` — hydrated data renders
instantly, then revalidates. Keep filter/selection UI state in a Zustand store.

**4. `loading.tsx`** — a skeleton that shows during the server prefetch window.

> The page prefetch key and the hook's `useQuery` key MUST be identical (both
> `qk.foo(org)`) — that match is what makes hydration hit instead of refetching.

## Live updates, not polling

Data that can change without the viewer's own action is **live by default** (ADR 0005 §7 Q3,
#6115): the org's change stream sends a topic hint, and `lib/query/topics.ts` `TOPIC_KEYS` maps
the topic to the query keys to invalidate. Add your keys there and do not set `refetchInterval`.
`pnpm -C apps/console run check:no-polling` fails on a new `refetchInterval` or `setInterval`
that is not in `no-polling-ledger.json`, and the ledger's polls only shrink. While the stream is
down, the one sanctioned fallback poll (`lib/realtime/client/fallback-poll.ts`) refreshes every
topic's keys.

## Mutations

`useMutation` + `invalidateQueries({ queryKey })` on success replaces the old
"call the action, then manually refetch the store" dance. Optimistic updates can be
layered with `onMutate`/`onError` rollback where the UX warrants it.

## Zustand boundary

Zustand stays for **ephemeral UI / selection / design state** — filters, pagination,
selection, command-palette visibility, the design canvas graph, the design-project
provider/identity/pricing selections, workspace/org context. Anything that is a
*navigation-prefetched server-data list* belongs in a query hook. After the migration:

- Keep (pure UI / session): `use-alerts-section`, `use-artifact-store`,
  `use-command-palette`, `use-workspace-store`, `use-setup-guide-store`.
- The design canvas is `lib/canvas/store/` (#6764, #7129): a document store and a view store per
  board, one board per project:environment. It holds no server data: the cards the design does
  not own are built from their queries (`use-board-sources.ts`) and read through context.
- Keep (design-surface state in `components/design-project/`, driven by in-canvas user
  actions rather than navigation — same category as the canvas store):
  `use-cloud-provider-store` (selected provider/identity + its cached resources).
  (`use-pricing-store` was on this list and is gone — #2873 found nothing imported it.)
- Slimmed to UI state: `use-jobs-store` (filters/pagination), `use-projects-store`
  (favorite ids).
- Removed (list data → queries): `use-clusters-store`, `use-runners-store`,
  `use-fleet-store`.

## Server-side filters (the standard)

Every list page filters **server-side** through one pipeline. No page invents its own
filter plumbing again:

```
zustand store  →  debounce  →  normalize  →  TanStack key  →  server action
(per page)        (search)      (stable obj)   qk.foo(org, q)    (filters + facets)
```

1. **Store** — one per surface via `createFilterStore` (`lib/stores/create-filter-store.ts`):
   `{ filters, set, patch, replace, reset, enterScope }`. `countActiveFilters`
   drives the reset affordance / badge counts, so **one user choice must be one key**: a date
   choice is a single `range` value, never `from` + `to` + a label (#6731), or one pick reads
   as "Reset · 3".
   **A store remembers nothing by default (#6814).** `persist` defaults to `false`: nothing is
   written to, or read from, sessionStorage, and the URL is the store's only memory. A list
   route prefetches its first page from the link alone, so a selection remembered anywhere
   else is a key the server did not prefetch — the first paint then changes after hydration.
   `persist: true` is an opt-in for a surface whose route does not prefetch from the link.
   **Every store has a scope key, persisted or not (#6730).** A store is a module singleton,
   and one definition can back several routes — jobs serves `/{org}/~/jobs` and every
   `/{org}/{project}/jobs`; access and activity serve an org and a project settings page; every
   store serves every org the tab visits. The scope key is the page's pathname, which
   `useFilterUrlSync` enters on mount. Entering a different pathname drops the in-memory
   selection of the last one, so a search typed on org jobs does not appear on a project's jobs
   page, nor in another org. A `persist: true` store keys its storage on `<name>:<pathname>`
   as well, and reads and writes nothing until a scope is entered.
2. **URL sync** — `useFilterUrlSync(store, defaults)` (`hooks/use-filter-url-sync.ts`)
   mirrors non-default filters into the search params (arrays comma-joined) so filtered
   views are shareable. **On mount the link REPLACES the store; it is never patched over it
   (#6814).** The store becomes `filterStateFromUrl`: the defaults with the link's filter
   params applied. A param the link does not carry is that filter's default, whatever the
   store held — so `?statuses=CANCELLED` is that one status and nothing else, and a bare URL
   is the pristine list. Merging was the defect twice over: a link came back with a
   remembered `search` folded in, and a bare link kept an earlier visit's selection; both are
   views the link did not describe and the server had not prefetched. The store therefore
   equals `filterStateFromUrl` for EVERY link, which is what the page's RSC parses to prefetch
   the matching key. The one exception is a `persist: true` store, where a link carrying none
   of the store's filter params leaves what that pathname persisted in place.
   A page whose URL also carries a selected row passes
   `{ resetParams: FILTER_DEPENDENT_PARAMS }`: that param is dropped by a URL write that
   changes a filter, and kept by any other (see "View state in the URL" below).
3. **Debounce** — free-text goes through `useDebouncedValue` (`hooks/use-debounced-value.ts`)
   before it reaches the key, handed what `useFilterUrlSync` returned:
   `useDebouncedValue(filters.search, 250, { urlRead })`. Only TYPING is debounced; a search the
   link carried lands in the key at once. Without `urlRead` the debounce starts from the store's
   default `""`, so a filtered link fetches — and, under `keepPreviousData`, shows — the
   unfiltered list for the whole delay (#5861). `pnpm check:filter-standard` fails F3 on a
   search debounce that is not handed it.
4. **Normalize** — build a stable query object (trim strings, sort arrays, drop empty
   keys) in a pure `normalize*Query()` helper, and put **that object in the query key**
   (precedent: `qk.roles(org, search)`). Unsorted arrays fragment the cache.
5. **Fetch** — `useQuery({ queryKey: qk.foo(org, q), queryFn: () => getFoo(q),
   placeholderData: keepPreviousData })`; dim the results with `opacity-60` off
   `isPlaceholderData`. No `firstRun` refs, no `cancelled` flags — TanStack owns
   request lifecycle.
6. **Facets** — the server action computes facet option counts over the **unfiltered**
   universe (options must not disappear as you select them) and returns them next to
   the rows. "Unfiltered" still means inside the scope — see the next section.

### Scope is a predicate, never a filter

The **scope** of a list is the part of the question the user did not choose on this page: the
org, and on a project page the project. It comes from the route (`/{org}/…`,
`/{org}/{project}/…`), never from the filter bar. A **filter** is what the user picked in the bar.
The two are applied differently, and mixing them up is a defect in either direction:

| | Rows pass | Facet pass | In the store | In the URL | Counts on "Reset · N" |
| --- | --- | --- | --- | --- | --- |
| Scope (org, project) | applied | **applied** | no | the pathname | no |
| Filter (search, statuses, range…) | applied | not applied | yes | a search param | yes |

- **A builder builds the scope predicates once and puts them in BOTH passes.**
  `queryActivityPage` builds `scopeOf(orgId, projectId)` and hands it to the rows pass and to
  every facet pass (`lib/queries/activity.ts`); `queryAccessGrantsPage` does the same with its
  `scopeConditions` (`lib/queries/access-grants.ts`). In both, `projectId` selects the
  universe; it is not one of the filter conditions. A project page whose facet pass sees only the org offers
  options, with counts, for rows the page can never show.
- **A project page never expresses its project as a filter.** Pre-selecting the project in a
  `projects` filter leaves the facet pass org-wide, shows a removable chip for something the
  user cannot change, counts 1 on "Reset · N", and writes `?projects=…` into a URL whose path
  already says it. The filter that IS the scope is hidden on the scoped page instead (the
  Project facet on a project's Activity feed).
- **The scope reaches the read from the route, not from the filter store.** The page passes
  the project it is under into the read's input (and so into the query key), the same on the
  server component that prefetches and on the client that asks, so two scopes never share a
  cache entry.
- **The store's scope key is the same thing on the client.** `useFilterUrlSync` enters the
  pathname, so a change of org or project is a change of scope and drops the filters.

A builder's unit test should assert both halves: the facet options do not shrink as the query
narrows (step 6), and they DO shrink to the project's rows when the scope narrows.

### View state in the URL

Two more params describe a list page, and neither is a filter. They are decoded in
`lib/query/view-url-params.ts`, on the same `ParamReader` as the filter codec, so the route's
server component and the client read a link identically:

| Param | Read | Write | Absent or unreadable means |
| --- | --- | --- | --- |
| `?selected=<id>` | `selectionFromUrl` | `selectionPatch` | nothing is open |
| `?range=<value>` | `rangeFromUrl` | `rangePatch` | the page's default window |

A patch goes through `hrefWithParamPatch`, which leaves every other param alone. A selected row
only means something under the filters it was chosen with, so it is in `FILTER_DEPENDENT_PARAMS`:
hand that to `useFilterUrlSync` as `resetParams` and a filter change closes it, while a link that
carries filters AND a selection opens exactly that row. **There is no `?page=`** — it and its
helpers (`pageFromUrl`, `pagePatch`) were deleted with LST-14 (#7496); the guard's `page-url` rule
fails a call if one comes back. The cursor is never in the URL; it is the infinite query's
`pageParam` (see "Paging"). `range` here is for a page that keeps its time window out of the filter store;
where the window is a store key it is an ordinary filter and step 2 already mirrors it. Either
way it is one value (`lib/query/range-filter.ts`), so a preset link stays relative.

**Visual grammar** (primitives in `@repo/ui`): `FilterBar` is the row; `FilterSearch`
is the input; `FacetFilter` (checkbox popover) for any option list; `FilterChipGroup`
for ≤ ~7 always-visible options (stages); `MultiCombobox` for long/searchable entity
lists (clouds via the option `leading` icon slot, authors, projects); `FilterBarReset`
for the mono "Reset · N" — a count of the USER'S OWN choices, which stays. A list carries **no
result count** at all: see "Counts" below (this paragraph used to require a count pill; the
maintainer removed it on 2026-11-24, #7481). Radix `Select`s and stat-card strips are
banned from filter bars.

The evidence page is the reference implementation; jobs (`getJobsPage` + `useJobsFilters`),
runners (`getRunnersPage` + `useRunnerFilters`), and activity (`queryActivityPage` +
`useKeysetList`, the keyset-paged variant — the cursor is the `pageParam`, never part of the key)
follow it (#578).

**Every surface is on it — seventeen since the clusters and environments lists joined (#6819) —
and `pnpm check:filter-standard` GATES that** (#4890). It used to print a per-surface score and
exit 0 — which is how ten of the then fifteen came to blank their list on a filter change with
every check in the repository green. A surface that fails
F1–F6 now fails the check, and the census it scores is floored from below so the finding
cannot be silenced by deleting the surface. A deviation that genuinely cannot conform yet goes
in that script's `FILTER_STANDARD_DEBT` with an owner and a mechanism — it is empty today, and
it is checked in both directions, so an entry that outlives its finding fails too.

**Three surfaces resolve their query in memory, deliberately, and each says so.** A runner row is
a composition of the RLS read (the org's own runners) and the service read (the platform's
managed fleet, `[]` on hosted), not a table's row, so `queryRunnersPage()` narrows over the
composed universe rather than in SQL and pages it in memory on the server through the keyset
contract, the org's default runner pinned first on page one (`lib/queries/runners.ts`, #7484). A cluster row is composed the same
way (the RLS read, the PDP's project visibility, drift and probe evidence) and the status it is
filtered under is derived from all of it (`lib/queries/clusters.ts`); a project's environments are
read once for the whole Environments page, whose other panels need every one of them
(`lib/queries/environments.ts`). What does NOT change is step
6: the facet pass is handed the whole universe and never the query, and
`tests/lib/queries/runners-page.test.ts`, `clusters-page.test.ts` and `environments-page.test.ts`
assert the option set does not shrink as the query narrows (and, for clusters, that it does shrink
to the project's rows when the scope narrows). Reach for this shape only when the universe is genuinely composed; a single table's
list page filters in SQL.

**The URL→RSC variant (blessed for RSC-rendered grids).** The org overview keeps its
`searchParams → RSC → props` model instead of store→key→`useQuery`, and that is the
CORRECT form of this standard when the grid itself is server-rendered: the URL is the
store (shareable by construction, non-default-only params — the same codec
`useFilterUrlSync` emits), the RSC prefetches the FIRST keyset page of `queryProjectsPage`
(facets over the unfiltered universe) under the infinite key `useKeysetList` asks for, the
browser reads every later page itself (LST-4 #7486), `useTransition`'s `isPending` plays the
`keepPreviousData` dim, the search box debounces its draft before touching the URL, and the
paging and counts rules below apply unchanged. A pristine `/{org}` URL means pristine filters, which since #6814
is what the store form does by default too. Use the TanStack form for client-fetched lists; use URL→RSC when the page is an
RSC that renders the rows itself. Do not convert one into the other without a reason.

## Paging (the standard, #7481)

Every list pages ONE way: **keyset**, server-side, through one cursor codec. Before this the
console paged six ways (keyset, grow-limit, client page numbers, a client render window, silent
server caps, none), three lists silently dropped rows past a cap, and eight shipped their whole
universe to the browser to page it there.

**Server.** A list reads through a `query<Thing>Page(tx, scope, query, { cursor, limit })` builder in
`lib/queries/`, returning `KeysetListPage<Row, Facets>` (`lib/queries/keyset.ts`):

```ts
{ rows: Row[]; nextCursor: string | null; facets: Facets | null; universeEmpty: boolean | null }
```

`facets` and `universeEmpty` come on the FIRST page only (`keysetListPage(page, first)` sets them
null on any later one). The order is total: the sort key, then the id. The pieces, all in
`lib/queries/keyset.ts`:

| Piece | What it does |
| --- | --- |
| `keysetPageInput(kind?)` | spread into the procedure's `z.object({ ...filters, ...keysetPageInput() })`: an opaque `cursor`, decoded at the boundary, and `limit` (default 50, **refused** above 100 — never clamped). A malformed cursor fails validation, which oRPC answers **400** — never page one. |
| `keysetSortKey(col)` | the sort key truncated to milliseconds. Pass THIS to both of the next two: the order and the predicate must read one expression, or a row in the cursor's millisecond but a later microsecond is skipped (the support list's lesson, #7389). |
| `keysetOrderBy(key, id)` / `keysetAfter(key, id, cursor, kind?)` | `ORDER BY key desc, id desc` and the row-value predicate `(key, id) < (at, id)`. |
| `keysetFetchLimit(limit)` → `keysetPage(rows, limit, keyOf)` | read `limit + 1`, cut to `limit`, mint `nextCursor` from the last kept row — so the end is known exactly, with no wasted empty page. |
| `keysetPageInMemory(universe, request, keyOf, kind?)` | the same contract over a COMPOSED universe (runners, clusters, environments): ordered and cut on the server, so the browser still receives one page. |
| `encodeKeysetCursor` / `decodeKeysetCursor` | the codec: base64url over a versioned `(ms ISO instant, id)` tuple. Opaque on purpose. |

External sources map their native cursor onto `nextCursor` (Stripe's `starting_after`). A
**bounded** list — configuration whose size the product caps — may be unpaged ONLY with a recorded
decision naming the server-side bound (a `bounded` file in `apps/console/list-standard/`).

**Client.** `useKeysetList(orpc.<domain>.<proc>, normalizedQuery)` (`lib/query/use-keyset-list.ts`)
wraps `useInfiniteQuery`: the cursor is the `pageParam`, **never in the key and never in the URL**; a
filter change is a new key, so the walk restarts at page one; `keepPreviousData` keeps the old rows
(dim them on `isPlaceholderData`, `opacity-60`); rows are joined across pages keeping each id once.
Render the rows through `<DataTable keyset={list} …>` (server mode: every loaded row, no client
sort or pages — DataTable has no page numbers, rows-per-page picker or "Show more" window in
either mode since LST-14) or a card grid followed by `<ListFooter list={list} />` (`components/list/`): an
invisible scroll sentinel PLUS an always-visible "Load more" button (keyboard, screen reader, no
IntersectionObserver), a busy state while a page is in flight, a "Couldn't load more · Try again"
line on a failed page with the rows kept, and **nothing** at the end. A route that prefetches the
first page uses `prefetchInfiniteQuery` with the same `infiniteOptions`, so the keys agree.

**States**, one each: first page pending → the skeleton / DataTable placeholder rows;
`universeEmpty === true` → `EmptyState` with the create action; rows empty and
`universeEmpty === false` → `EmptyState` "No … match these filters" + "Clear filters";
first page failed → `RegionError` with retry (`list.query`); a refresh failed behind rows → rows
stay plus DataTable's stale notice; a later page failed → rows stay plus `ListFooter`'s retry line.

**Banned:** client page numbers over fetched rows (a client-mode DataTable over a fetched list,
`.slice` page arithmetic, `?page=`), render windows over a fully fetched list, grow-limit re-reads, silent
server caps, the rows-per-page `Select`.

## Counts (the standard, #7481)

- **No count pill on a list.** `PageToolbar` and `SectionHeading` have no `count` prop and
  `CountPill` is deleted (LST-14, #7496); the guard's `count-pill` rule fails one coming back.
  A list's size is its rows, each marked `data-list-item` — count those.
- **No "N of M", "Showing X of Y" or "N total" prose** anywhere around a list.
- Totals exist only as **facet option counts**, computed by the facet pass. `universeEmpty` is a
  boolean, never a count.
- A number that IS the content (the agent artifact tile's plan counts) is not a list count, and
  it is not a pill: it renders as plain content (`CountFigure` at display size).

## The guard and its ledger

`pnpm check:filter-standard` measures both sections above (`scripts/check-filter-standard.mjs`,
"the LIST standard") as site counts per subject — a module, or a filter surface
(`store:<symbol>`) — under nine rules: `count-pill`, `count-prose`, `page-slice`,
`render-window`, `page-url`, `grown-limit`, `client-table`, `keyset-contract`, `keyset-builder`.
The census is wider than the filter surfaces: any module that renders a `DataTable`, calls
`useKeysetList`, or hand-rolls an infinite query is a list subject, so a list with no filter bar
cannot escape. F5 (inverted: no pill) is gated here too.

A site is either fixed or declared in `apps/console/list-standard/<surface>.json` as a **bounded**
decision — **one file per surface**:

```json
{ "kind": "bounded", "decided": "LST-9 (#7491) …", "decision": "…", "bound": "`SSO_PROVIDERS_MAX` (20) …",
  "findings": { "store:useSsoFilters": { "keyset-contract": 1 } } }
```

`bounded` names an unpaged list whose size the product caps, with the SERVER-SIDE bound, and may
excuse only paging rules — never a count, never a builder. It is the only kind: `debt` (a finding
with the open LST issue that removed it) and `content` (a count that was the content) were retired
when the epic closed with LST-14 (#7496), and a file of either kind fails. The declared count must
EQUAL the measured one, both ways: a new site in a declared module fails, and so does a declaration
that overstates what is left. Bounded files sit under a ceiling in the script
(`LIST_STANDARD_CEILINGS`).

## Realtime

Job **logs** stream over Postgres `LISTEN`/`NOTIFY` → SSE on their own route and are unchanged.
Everything else uses the org's change stream (`/{org}/~/events`, ADR 0005 D3): it carries
**invalidation hints** (`{topic, id}`), never data. The client in `lib/realtime/client/` runs one
stream per browser per org, coalesces the hints with jitter, and calls `invalidateQueries` on that
org's QueryClient, so each refetch goes back through the read router (RLS + the PDP). See
"Live updates, not polling" above.

## Page migration status

| Route | Resource | Status |
| --- | --- | --- |
| `~/jobs`, `~/jobs/[id]` | jobs | query (pilot) |
| `~/runners` | runners + fleet | keyset — the grid is `useKeysetList(orpc.runners.page, q)` over `queryRunnersPage` (#4890, #7484) |
| `~/clusters`, `[project]/clusters` | clusters | query — the table is `clusters.page`, scoped by the route (#6819) |
| `[project]/environments` | environments | query — the table's rows are the read's `page` (#6819) |
| `~/` overview, switcher, palette | projects | query |
| `[project]` | pricing + cloud resources | query |
| `~/alerts` | settings · channels · policies · deliveries | query over GET (`alerts.*`), prefetched; live on the `alerts` topic (#6125) |
| settings/* | teams · members · access · roles · sso · activity | RSC + `loading.tsx`; every filtered list is a query |
| `~/connectors`, `~/new` | (server-rendered already) | RSC + `loading.tsx` |

The alerts row is the one worth reading twice. There is no bootstrap any more (#6125): the hub's
settings (the plan gate, `canManage`, the event catalog) are `alerts.settings`, and the universes
the panels cross-reference against are the lists' PRISTINE pages — the same keys the panels read
unfiltered. Every write invalidates `alertsKeys()` from the acting tab, and the `alerts` topic
invalidates the same keys everywhere else, so nothing on the hub needs `router.refresh()` — the
failure #2878 refused the first conversion over cannot recur.
