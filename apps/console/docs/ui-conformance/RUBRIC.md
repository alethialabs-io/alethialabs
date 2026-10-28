<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The console UI conformance rubric

**44 predicates** over every **private** console route — S1–S4 (4), T1–T7 (7), H1–H9 (9), F1–F10
(10), R1–R8 (8), B1–B6 (6). This file is the contract: the static checks, the live Playwright `audit` project
and the scoreboard generator all implement predicates defined *here*, and none of them may invent
one.

> That count was wrong three different ways at once until #3618: this line said twenty-six, the
> commit that seeded the file said 25, and the tables below have defined 33 the whole time. It is
> now **derived and checked**, not typed — `apps/console/scripts/audit-report.mjs` reads the
> predicate rows out of the tables and refuses to run when this sentence disagrees with them. A
> scoreboard must name what it scores.

The route set is not in this file. It is **derived** by `scripts/lib/console-routes.mjs`, which
raises rather than returning an empty list — a route the audit never visited and a route that scored
zero are indistinguishable in a report whose denominator came from somewhere else.

> Run `node scripts/lib/console-routes.mjs --summary` to see the current route set. Today: **40
> private routes, 4 of them redirect-only, 36 real pages.**

## Why a rubric rather than a list of fixes

CLAUDE.md §6 already decides how a heading, an empty list, a status pill, a table, a layer and a
number should look. What did not exist was a way to ask *whether a given page obeys it* — so the
answer was always somebody's reading, and the readings disagreed. Measured on `dev`: 24 raw `<h2>`
across five type scales, ~30 hand-rolled empty states at six different heights, three grid-as-tables,
two money formatters the existing guard structurally cannot see.

A score makes the disagreement a number, and a number can ratchet.

## How a predicate is scored

Every predicate returns exactly one of:

| verdict | meaning |
|---|---|
| **PASS** | the page does the thing |
| **FAIL** | the page does not do the thing, and it should |
| **N/A** | the predicate does not apply to this page, **with the reason recorded in the record** |

`score = PASS ÷ (PASS + FAIL)`. N/A leaves the denominator, which is why the next section is the
most important one in this file.

### N/A is where a rubric goes wrong

A caveat rendered as a `case` that *replaces* the verdict is a defect class this repo has already
shipped. The failure looks like this: a predicate is hard on some page, somebody adds a condition
that returns N/A, and the page's score goes **up** because its denominator went down. Nothing red
appears anywhere.

Three rules close it:

1. **Every N/A carries a machine-readable reason string**, from the fixed set each predicate
   declares below. A reason that is not in the predicate's declared set is an error, not an N/A.
2. **The N/A condition must be derivable from the route record**, never from the page's own
   content. "This page has no empty state" is not an N/A reason — it is the thing being measured.
   "This page is redirect-only" is, because `isRedirectOnly` is structural.
3. **The scoreboard reports N/A counts per predicate as a first-class column.** A predicate whose
   N/A count grows is a predicate being escaped, and it is visible without anyone auditing for it.

The one N/A that applies broadly: **the 4 redirect-only pages** (no JSX, a `redirect()` call —
`/[org]/[project]`, `/[org]/[project]/settings`, `/[org]/~/settings`, `/dashboard/[[...rest]]`)
render nothing a person looks at. They are N/A for every predicate except T2 and T4.

---

## Family S — shell and width  ·  static

| id | predicate | PASS when | N/A when |
|---|---|---|---|
| **S1** | the page renders inside a known shell | `record.shell` is non-null — a `*Shell` discovered under `components/**` is mounted somewhere in the layout chain | `redirect-only` |
| **S2** | exactly one max-width governs the content | the innermost shell declares a `max-w-*` and the page declares none of its own | `redirect-only` |
| **S3** | the loading skeleton is the same width as the page | the nearest `loading.tsx` resolves to the same max-width as S2 | `redirect-only`; `no-loading-boundary` — there is no skeleton to measure, and T1 already reports that, so do **not** double-count one defect. A skeleton that EXISTS and is the wrong one is still measured here: its width either matches the page's or it does not, and that is a second fact, not the same one twice |
| **S4** | no page-local duplicate of a shell constraint | the page file and its direct children declare no `max-w-*` that a shell above them already sets | `redirect-only` |

**Why S2 says "and it comes from the shell".** Eleven pages set no max-width at all and fill a 4K
monitor; three others hand-roll `max-w-[1200px]`, which is the number `SettingsShell` already owns.
Both are the same defect — the width is not decided in one place — and a predicate that only caught
the first would let the second spread as the fix.

## Family T — states  ·  T1–T4 static, T5–T7 live

| id | predicate | PASS when | N/A when |
|---|---|---|---|
| **T1** | the page's loading skeleton is *its own or a correct ancestor's* | `boundaries.loading.own`, **or** an inherited one whose page shape genuinely matches (see below) | `redirect-only` |
| **T2** | an error boundary covers the segment | `boundaries.error.file` is non-null | never — every route can throw |
| **T3** | `notFound()` has a `not-found.tsx` in its own chain | the page calls `notFound()`, the nearest `not-found.tsx` is scoped to the same resource, **and it can fire** — no layout at that resource's own segment throws past it | `does-not-call-not-found` |
| **T4** | the page declares metadata | `hasMetadata` — on the page, or on its own layout for a client page | never — a redirect still owns a title |
| **T5** | the empty state renders through `EmptyState` | driven against an empty org, the rendered empty region resolves to `@repo/ui/empty` | `no-empty-state` (the page has no list, tab or panel that can be empty) |
| **T6** | the error state renders through the shared error component | fault-injected, the page renders `components/errors/error-state` | `redirect-only` |
| **T7** | permission-denied renders a real state | as the `operator` persona — which is the restricted one, and the `member`/`viewer` persona is not; see below — a forbidden page renders a deliberate state, not a blank | `no-restricted-surface` |

**T1 is "the nearest one", not "one exists".** Next.js gives a page the closest ancestor-or-self
`loading.tsx`, so the question is which skeleton actually renders. Measured today:

| route | renders | distance | verdict |
|---|---|---|---|
| `/[org]/~/settings/classification` | `[org]/loading.tsx` — the org-overview card grid | 3 | FAIL |
| `/[org]/~/jobs/[id]` | `~/jobs/loading.tsx` — the jobs **list** skeleton | 1 | FAIL |
| `/[org]/~/settings/billing/invoices` | `~/settings/billing/loading.tsx` — the billing **panel** skeleton | 1 | FAIL |
| `/cli/login` | nothing, anywhere in its chain | — | FAIL |
| `/[org]/[project]/settings/{access,activity,general}` | `[project]/settings/loading.tsx` | 1 | **PASS** |

The last row is the reason T1 is not simply `boundaries.loading.own`. A settings sub-page inheriting
the settings skeleton is *correct*, and a gate that failed it would be a gate people learn to ignore.
An inherited skeleton passes when the segment that owns it has **no page of its own to have been
written for** — a redirect-only page, or no page at all; otherwise it fails. `[project]/settings`
only redirects, so `[project]/settings/loading.tsx` exists for the sub-pages beneath it and they
PASS. `~/jobs` and `~/settings/billing` are real pages, so those skeletons are theirs and the routes
below inherit somebody else's — which is what the two middle rows record.

That rule is structural — it reads `isRedirectOnly` off the route record — and it is deliberately
not "the two pages share a shell and a width". Sharing a width is a property of how the pages look
today: `~/settings/billing/invoices` shares both with `~/settings/billing` and still renders the
billing **panel** skeleton over an invoice table, which is the defect this row is measuring.

**T3 is about the resource, not the file.** Before #3880, 38 of 40 private routes resolved to
`[org]/not-found.tsx` — including every project-scoped route, so a bad *project* slug answered
"Organization not found… or you don't have access". The nearest boundary existing is not the
predicate; the nearest boundary naming the right thing is.

**And it is about the boundary being able to fire.** A segment's `not-found.tsx` is handed to the
`LayoutRouter` for that segment's **children** slot, so it mounts *inside* that segment's own
layout: a `notFound()` thrown in a **page** is caught by its segment's boundary, and one thrown in
that segment's own **layout** is not — it unwinds to the next boundary above. #3880 is that
distinction. Nine `[project]/**` routes failed T3 because their layout threw, and dropping a
`not-found.tsx` beside that layout would have flipped all nine to a PASS the boundary could never
deliver, which is why the predicate reads the layout chain and not only the page. The rule:

- the throw is in the **page** → the segment's own `not-found.tsx` catches it;
- the throw is in a **layout** at segment X → the catching boundary must be **strictly above** X,
  and when X *is* the innermost dynamic segment that is unsatisfiable together with the scope half.
  The fix is to move the throw, not to move the file.

Two bounds are stated in `scripts/check-route-states.mjs` rather than left implicit: the N/A gate is
still the **page's** `notFound()` (a layout-only throw, such as `[org]/layout.tsx`'s, is not
reported), and only layouts **at or below** the route's innermost dynamic segment are read (one
above it throws about an outer resource and is measured on that resource's own routes).

**T7's persona is a measurement, and the first one measured nothing.** #3894 ran T7 as a Better Auth
`member` — which `MEMBERSHIP_ROLE_ALIASES` resolves to Alethia's `viewer` — and all 27 org-only
routes came back `no-restricted-surface` (#3898). T7 rendered `—`, honestly, and could not fail.
Neither the predicate nor the fixture was the gap. The **privilege ladder the predicate assumed**
was, and there isn't one.

The console refuses a route at *render* time in exactly three places — a server component that awaits
a bootstrap, catches `ForbiddenError`, and renders a deliberate no-access `Alert`:

| page | needs | refused to |
|---|---|---|
| `app/(private)/[org]/~/alerts/page.tsx` | `alert:view_alerts` | **no built-in role** |
| `app/(private)/[org]/~/settings/roles/page.tsx` | `member:view` | `operator` |
| `app/(private)/[org]/~/settings/sso/page.tsx` | `member:view` | `operator` |

Everywhere else the console authorizes at the **action** level: the page renders for anybody in the
org, and a capability flag (`canManage`, `canManageCaps`, `seeAll`, `canInvite`) takes affordances
away rather than refusing the route. `~/settings/billing` and `~/settings/activity` are client panels
whose read actions resolve `currentActor()` and enforce nothing at all.

So a `viewer`, which holds both `member:view` and `alert:view_alerts`, is refused none of the three;
an `operator` is refused two. The two roles are **incomparable** — `lib/authz/org-access-control.ts`
says so in `toPdpRole`'s own doc: a viewer may read members, an operator may deploy. "Least
privileged" is not a total order here, and the least-privileged actor for the console's *route-level*
gates is the operator. T7's persona is therefore an `operator`, invited through the same endpoint the
console's own invite dialog calls with a role that dialog offers — and **nothing is seeded for it**:
both surfaces exist in every org, on every plan, with no rows written. That is what makes the answer
"the persona was wrong" rather than "the fixture was thin". There was no thin fixture to thicken.

Two consequences this file owns rather than leaves implicit:

- **T7's subject is small, and named.** Two routes of 27. The other 25 record `no-restricted-surface`
  and mean it. A predicate over two routes can fail; a predicate over none cannot, and that is the
  only distinction that matters here.
- **The subject is asserted, not assumed, in both directions.** `e2e/audit/permissions.spec.ts`
  derives the persona's permission bundle from `lib/authz/registry.ts` and **fails** if the persona
  turns out to be refused nothing. And the two gated routes are T7's **positive control**: a route
  the registry says the persona cannot load, which nevertheless reads as unrestricted, fails rather
  than recording a quiet `no-restricted-surface`. So the day the last route-level gate goes, T7 says
  so — instead of returning to a column of dashes that nobody can tell from "not run yet", which is
  the failure this wave exists to prevent.

`~/alerts`'s no-access branch is reachable by **no built-in role at all** — only a custom (Enterprise)
role, or a member left with zero grants (#3754). Recorded here, deliberately not measured: inventing a
custom role to reach it would be fabricating the subject rather than finding it.

## Family H — the shared surface  ·  static

Each row is a row of CLAUDE.md §6's table. H1 was guarded before this family existed; H2–H7 are what
unit #3615 added; H8 is what #3733 added with the type scale itself; H9 is what #3798 added when
building the scoreboard found that CLAUDE.md §6's `EmptyState` row was scored by nothing.

| id | predicate | PASS when | N/A when |
|---|---|---|---|
| **H1** | the page has **no** title | no `<h1>` outside the allowlist — see below, this predicate is inverted | `redirect-only` |
| **H2** | every section heading comes from `SectionHeading` | no raw `<h2>`–`<h6>` outside the allowlist | `redirect-only` |
| **H8** | every font size is a `--text-ui-*` rung | no `text-[Npx]` (any length unit, any variant prefix) outside the allowlist | `redirect-only` |
| **H3** | status renders through `StatusBadge` | no local status→variant map, and no raw `.vx-status` re-implementation | `renders-no-status` |
| **H4** | tabular data renders through `DataTable` or `@repo/ui/table` | no header row over repeated `grid-cols-[…]` row children | `renders-no-table` |
| **H5** | every number, date, size and amount goes through `@repo/format` | no `toFixed`, `toLocale{Date,Time}String`, `/1024`, hand-written currency symbol, or local `format*` duplicating a `@repo/format` export | `renders-no-formatted-value` |
| **H6** | no stat-card strip | no row of bordered label-over-number cells | `redirect-only` |
| **H7** | no bare numeric z-index | every `z-*` is a `--z-*` token from `packages/brand/src/tokens.css` | `declares-no-z-index` |
| **H9** | the empty state renders through `EmptyState` | the page's own module closure hand-rolls no centred empty region (`text-center` with `py-6` or more) outside the allowlist | `redirect-only` |

**H1 IS INVERTED, and the inversion is the predicate.** It used to read "the page title comes from
`PageHeader`". #3733: the page's name is said by the sidebar entry you clicked and by the breadcrumb
above the content, so the page's own heading is the third saying and earns nothing — the console has
no page titles. A page therefore PASSES H1 by having no `<h1>` at all. The test for the eleven
allowlisted exceptions is **does anything else on screen already name this?** — six are outside the
console shell, where there is neither breadcrumb nor sidebar (sign-in, the CLI hand-off, buying a
plan, accepting terms, OAuth consent, onboarding), and five are in-shell headings that say something
other than the route's name (a question, two invitations above an empty composer, an error message,
an `sr-only` outline root). "Is there a breadcrumb" is NOT the test, and applying it would delete
five headings this rubric deliberately keeps. `PageHeader` no longer exists: what survives
is `@repo/ui/page-toolbar` — the count pill, the description and the page's actions, none of which
the breadcrumb duplicates. **A page that loses its title must not lose its actions**, and H1 does not
measure that; T-family and R-family predicates do.

**H2's answer moved with it.** It was `PageHeader level={n}`, which rendered `text-lg font-medium`
whatever the level — so a section heading converted to it jumped to 18px from the
`text-[14.5px]`/`text-[15px]` the console actually typesets that rung at. That jump is what found the
missing type scale, and H8. The answer is now `SectionHeading` from `@repo/ui/section-heading`: one
rung (`--text-ui-lg`, 15px), with `level` setting the tag and nothing else.

**H8 is a ratchet, not a pass/fail on day one.** All measured live occurrences are recorded as `lifts:`
debt in `apps/console/shared-surface-allowlist.yaml` against #3742, so a page scores FAIL on H8 today
and the number can only shrink. A page with no arbitrary size left scores PASS. Nothing about H8 is
N/A for a page that renders text.

**H9 and T5 are two questions, not one instrument reported twice (#3798).** H9 is STATIC and asks
"does this file hand-roll a centred empty region?"; T5 is LIVE and asks "driven against an empty org,
what did the empty region actually resolve to?". Both are worth asking, and a page can fail either
while passing the other: it can import `EmptyState` and still render a blank region when the list is
empty, and it can hand-roll a centred div that the audit's empty org never reaches — 26 of the 40
routes are `no-empty-state` for T5 today, so the static matcher is the only instrument that sees
them at all. `check-shared-surface.mjs`'s `empty_state` rule had no row here until this one existed:
its occurrences were counted in the scoreboard's reconciliation and scored nowhere, which is what
#3798 was opened to end. Folding it into T5 was the alternative, and it was refused for the reason
this rubric states everywhere else — one predicate per question. The count moved 33 → 34.

**H5's hardest case is the one a grep cannot reach.** `billing/billing-checkout-form.tsx:118` builds
`${symbol}${n.toLocaleString("en-US")}` where `symbol` is a **variable**, and
`agent/approval-card.tsx:154` takes `prefix="$"` as a **prop**. The existing `$${` matcher can never
fire on either. A predicate that only tests the shapes the current guard can see would score both
pages PASS, which is worse than not asking.

## Family F — the filter standard  ·  F1–F6 static, F7 a unit test, F8–F10 live

N/A for every page that is not a list page — declared reason `not-a-list-page`, derivable from the
absence of a `lib/stores/use-*-filters.ts` store, not from how the page looks. F10 declares one more,
`no-search-field`, and it is structural in the same way: none of the page's surfaces carries a
`search` key in its store's defaults. Never "no search box rendered" — that is what F10 measures.

| id | predicate | PASS when |
|---|---|---|
| **F1** | a `createFilterStore` store exists for the page |
| **F2** | `useFilterUrlSync` is wired, so a filtered view is linkable |
| **F3** | search is debounced — typing only; a search the link carried lands at once (`{ urlRead }`, #5861) — and the **normalized** query object is the TanStack key |
| **F4** | the bar is built from `FilterBar` / `FilterSearch` / `FacetFilter` / `FilterChipGroup` / `FilterBarReset` |
| **F5** | the result count is a `CountPill` beside the heading — never "N of M" prose in the bar |
| **F6** | `keepPreviousData` plus the `opacity-60` dim on `isPlaceholderData` |
| **F7** | the server builder issues a rows pass **and a separate unfiltered facet pass** |
| **F8** | a filtered view survives the URL round-trip, **observed in a browser** | applying the first facet option that narrows puts one of the surface's params in the URL; the URL reloaded in a **fresh tab** (its own sessionStorage, so only the URL can restore it) keeps the param and the narrowed list; Reset clears every param the surface writes and the count returns to the full count |
| **F9** | facet counts do not move under a filter, **observed in a browser** | every option of the facet driven keeps its count, and no option vanishes, between before and after the first option is applied — F7 observed end to end |
| **F10** | search is debounced and lands in the shared empty state, **observed in a browser** | the data requests six keystrokes produce carry **at most one distinct** search value within 500 ms of the last one (a poll repeating the debounced value is the same value, not a second fetch), and a nonsense token renders `[data-slot="empty"]` inside `main` with no hand-rolled "No results" outside it |

The subject is a **surface**, not a page: one `createFilterStore` call site.
`lib/stores/use-settings-filters.ts` holds seven of them and `use-alerts-filters.ts` three, so a
per-module verdict would pool ten surfaces into two. A route owns a surface when its page closure
reaches both the store module and a module that names the store's symbol, and F1–F6 are the
conjunction over the surfaces a route owns — a bar that is not linkable is not excused by a sibling
on the same page that is.

**F7 is a unit test, not a matcher.** A facet's counts must come from the unfiltered universe: filter
in memory and the option you just picked disappears from the list, which makes the filter bar
un-un-selectable. "A facet pass sees only the scope predicates" is a behaviour, and the only honest
way to assert it is to run the builder against a fixture and check the second query's predicates.

**F8–F10 are the live half, and they are measured over a DERIVED subject set** (#4278).
`e2e/audit/filters.spec.ts`, in the `audit-interaction` project, asks
`apps/console/scripts/audit-report.mjs --filter-surfaces` which surfaces each route owns — the same
`ownedSurfaces()` join F1–F6 are scored through — and `scripts/check-filter-standard.mjs` which URL
params each surface writes, read from its `useFilterUrlSync` call rather than typed per page. It
refuses to run over fewer than 15 surfaces. What it drives is a seeded list: `e2e/helpers/seed-filters.ts`
writes at least two rows with differing facet values where it can, and a list that still renders
fewer than two rows is **NOT MEASURED with the count** — a filter over one row cannot narrow
anything, and scoring it PASS would be a measurement of nothing. That is a claim about the RUN, never
an N/A.

Its positive control runs before any route is scored, over four fixture bars with known answers —
one that never writes the URL, one whose counts move, one that fetches per keystroke, and one whose
rows share a single facet value so no option can narrow it, which must read NOT MEASURED on F8 and
F9 — and a red control withholds all three predicates for the run. The jobs surface is the known PASS the first real
run is read against.

**What F8–F10 cannot see is stated, not implied.** F8 and F9 drive the FIRST facet option the bar
offers that narrows the list, not every one. When no facet found has such an option, or the list does
not narrow once it is applied, both are **NOT MEASURED with the counts** — never PASS, because with the
list unchanged F9's before/after comparison and F8's restore and reset steps cannot fail. F10's "data request" is a server-action POST or a fetch carrying the
typed token, and the App Router's RSC refetch that `useFilterUrlSync`'s URL rewrite triggers is COUNTED in
the evidence but is not the debounce's question — so a surface can PASS F10 while its URL half still
round-trips per keystroke, and the evidence says how many times it did.

**A list is read when it has ANSWERED, not when it holds still** (#4980). `settle()` in
`e2e/audit/filters.ts` refuses any read taken while `main`, or anything in it, is `aria-busy="true"`,
and a read still busy when its budget runs out never counts as the reloaded list or the reset count.
Stillness alone cannot tell a `keepPreviousData` placeholder from an answer — `~/runners` and
`~/alerts` passed and failed F8 on unchanged code according to how long the filtered fetch took. The
console's filtered lists declare `aria-busy` until their rows answer the URL; a page that shows a
placeholder WITHOUT declaring it can still be misread, and that is the page's defect to fix.

The reference implementation is the evidence page —
`components/evidence/{evidence-client,evidence-filter-bar}.tsx` and `evidence-query.ts`, plus
`lib/stores/use-evidence-filters.ts` and `lib/query/use-evidence-query.ts`. Note it currently fails
H2: it hand-writes its own `<h2>`.

## Family R — rendered integrity  ·  live only

| id | predicate | PASS when | N/A when |
|---|---|---|---|
| **R1** | no horizontal page overflow | `scrollWidth <= clientWidth` on the body at 768 / 1280 / 1440 / 1920 | `redirect-only` |
| **R2** | every overlay computes above the chrome | see below | `opens-no-overlay` |
| **R3** | exactly one scroll container, and it is the shell's | one element in the page has `scrollHeight > clientHeight` with a scrolling `overflow` | `redirect-only` |
| **R4** | no two interactive elements overlap | no pair of focusable elements with intersecting layout boxes | `redirect-only` |
| **R5** | axe reports zero serious or critical violations, **in both themes** | `scanRouteThemes()` returns none at `wcag2a`/`wcag2aa` in **light and dark**, each violation naming its theme, and both themes applied and painted differently | never |
| **R6** | zero console errors, zero failed requests | nothing on `console.error`, no response ≥ 400 | never |
| **R7** | interactive within budget | p95 under the route's recorded budget | never |
| **R8** | every enabled control does something | every enabled `button`, same-origin `a[href]` and depth-1 `menuitem` in `main` — plus the shell chrome, measured once under `/[org]` — produces, within **1 000 ms** of activation, a navigation, a new overlay, a DOM mutation in `main`, an `aria-expanded\|pressed\|selected\|checked` flip, a network request, a download, a new tab or a toast (`role=status`, `role=alert`, or sonner's role-less `[data-sonner-toast]`, which renders outside `main`) | `redirect-only`, `no-enabled-controls` |

**R8 IS MEASURED WITHOUT EVER PRESSING A CONFIRM.** `e2e/audit/inert.ts`'s `activate()` refuses to
click while a dialog or an alertdialog is open, and a confirm button exists nowhere else — so the
guarantee is a property of the code rather than a rule the next reader has to remember. Inside an
overlay the only key pressed is Escape. A control **registered** in
`apps/console/destructive-actions.yaml` for that route IS activated, because its declared
confirmation is its effect and #4266 already proves that confirmation is real. A control the ledger
does **not** declare whose accessible name reads destructive is never activated and is recorded
**FAIL `unregistered-destructive`** — the live twin of the static census, and a finding either way:
either the ledger is short an entry, or a control is wearing a verb it does not carry out.

**R8 SCORES ONLY WHAT THE FIXTURE RENDERS, AND THAT BOUND DOES NOT CLOSE WITH MORE RUNS.** A control
behind a conditional the audit's empty organisation never reaches — a row action needing a failed
deployment, a button gated on a plan the run does not buy — is invisible to a live pass forever, not
until the fixtures improve. It is not measured, not failed and not counted, so **"R8 passed" never
means "every control in the console does something"**; it means every control this org rendered did.
Closing that gap needs a STATIC matcher over the handlers, which is a different instrument in a
different unit. The same reasoning is why H9 exists beside T5: one predicate per question.

**Two R8 outcomes are not "inert", and both are the page's own claim** (#4980). A control that
reports it is ALREADY in the state it selects — `aria-current` (any token but `false`),
`aria-selected="true"`, or `aria-checked="true"` on a `radio`/`menuitemradio` — and does nothing when
pressed records the effect `already-current`: selecting the current item again is correctly a no-op.
`aria-pressed="true"` counts only on a button with `aria-pressed` siblings — a one-of-N pressed group
such as the theme toggle; a LONE pressed toggle is expected to unpress and is still inert if it does not. And the
enumeration waits for the page to settle (no `data-slot="skeleton"`, no `aria-busy`, a stable control
count) before it runs; a route that never settled on its first load is **NOT MEASURED
`page-not-ready`** as a whole — never N/A `no-enabled-controls`, which is a claim about the page — and
so is a route whose reload after a dirtying control stops settling inside its short budget, so a
stuck route costs one bounded wait rather than one per control.

**ITS ERRORS ARE BIASED TOWARD PASS, deliberately.** Six of the seven effects are attributable to the
click. The seventh — a DOM mutation anywhere in `main` — is not: an async re-render provoked by the
PREVIOUS control can land inside this one's window. It is therefore checked LAST, after every
attributable signal, and the page is reloaded after any control that moved it. And "a network
request happened" is a signal the route has to EARN: `measureQuiescence()` watches the page for one
window before anything is clicked and withholds the signal on a route that chatters, because on a
page that polls, "a request happened" is true of every control and therefore evidence about none.

**Three things are declared out of scope, each with its reason, none of them silent.** A **disabled**
control is not scored — it is counted as `disabled-with-reason` / `disabled-no-reason` for a later
R9, because "why is this greyed out" is a different question. A reason counts only when the control's
`aria-describedby` RESOLVES to text; a `title` does not, and neither does an id that names nothing. A
disabled control never gets the hover that shows its title (`disabled:pointer-events-none`) and a
disabled button takes no focus, so a title-only reason reaches nobody (the review of #5000). The
console writes the counted shape with `@repo/ui/disabled-reason`. A control inside an **`inert`** subtree
is not enumerated at all: the browser has already taken it out of the click, focus and accessibility
model, so no user can reach it (#4939 — the chat scroller's faded-out "Scroll to latest"). An **external** link PASSES on a real
`href` and is never clicked: activating it navigates the run out of the console, and whether the
destination exists is not R8's question. A same-origin link that opens a **new tab** (`target="_blank"`)
is activated, and the tab it opens (`page.on("popup")`) is its effect; the tab is closed unread, for
the same reason — before #4939 nothing listened for it, so every same-origin docs link read as inert.
A control that opens a **file chooser** is detected (via
`page.on("filechooser")`, so the exclusion is reachable rather than vacuous) and excluded. So is the
shell's **sign out**, and that one is a single spelled-out pattern: revoking the run's session would
make every later verdict a measurement of the sign-in page wearing the route's name.

**A route over the control budget is `NOT MEASURED` WITH THE COUNT, never a PASS over the first 60.**
Sixty controls is what one leg can afford; a budget that silently truncates is a denominator nobody
can see. That is a claim about the RUN, which is what `report.ts`'s `notMeasured()` is for — as
against an N/A, which is a claim about the PAGE. `inert.spec.ts`'s last test fails when fewer than
`MIN_MEASURED` routes produced a PASS or a FAIL, because a column of nothing but NOT MEASURED must
not read as a clean board.

**R2 is measured by hit-testing, and this is the whole reason the live half exists.** Open each
dialog, sheet, popover, dropdown, tooltip and hover-card, then call
`document.elementFromPoint()` at the overlay's centre **and at its four inset corners**, and assert
the returned node is inside the overlay.

Grepping for `z-[var(--z-overlay)]` matches a *rendering of the intent*, not the stacking that
happened, and the two have already come apart in this codebase. `packages/ui/src/popover.tsx` carries
the incident in a comment: base-ui positions the popup via an absolute Positioner and leaves the
Popup itself `position: static`, on which **`z-index` is a no-op** — so a popover opened from inside
another positioned layer (the fullscreen Elench dialog) rendered *behind* it, while the class name
said `z-[var(--z-overlay)]` the whole time. The fix was a `relative`, which no z-index matcher looks
at. A page can name every token correctly and still put its popover behind the chrome; only a
hit-test knows.

**R3's first two honest FAILs were both DECORATION, and the predicate was right to report them**
(#3885). The support chip strip (`components/ai-elements/suggestion.tsx`) and the environments
consistency matrix each scrolled vertically by 3–4px, identically at all four widths, inside a
container that only ever wanted a *horizontal* affordance. One cause, in both: `.vx-clamp`
(`packages/brand/src/tokens.css`) draws its corner marks as a `::before` at
`inset: calc(-1 * var(--cl-gap))` — 2px or 4px **outside** the element — precisely so that a control
never reflows when it clamps. A scroll container measures that decoration as content, so any
`.vx-clamp` element flush against a scroll container's block end adds `--cl-gap` of phantom scroll.
The general shape, for the next reader: an unexplained few-pixel R3 finding is decoration reaching
past a box, not a layout that is genuinely too tall.

**The predicate was not made axis-aware, and no N/A was declared.** R3 already reads only
`overflowY` and `scrollHeight`, so it is vertical-only in the sense that matters — a horizontal strip
whose content fits vertically has never been a finding, and admitting `data-slot=scroll-area-viewport`
would have exempted every inner scroller on every route to excuse two. An "only if it overflows by
more than *N* pixels" arm would have been worse: a threshold picked to clear the two pages in front
of it is the guard weakened until the defect fits through, and the pages would have re-failed the
day a chip grew a pixel. The two containers reserve `--cl-gap` on the block axis instead.

**R5 needs one thing fixing before it can be believed.** `e2e/helpers/a11y.ts` currently returns `[]`
when `@axe-core/playwright` cannot be imported. A silent empty result is indistinguishable from a
clean page — it must raise.

---

## Family B — behaviour  ·  live only  (ADR 0005, #6113 · measured by #6116)

The families above score SHAPE: a route can pass all of them and still load in a queue, flash a
default identity, and say "No results." while it waits — every page of the 2026-10-19 hunt did. Family
B scores what the user experiences. B1–B5 are measured by `e2e/audit/behaviour.spec.ts` in the
`audit` project; B6 belongs to the real-time bus (#6115) and has no instrument yet.

| id | predicate | PASS when | N/A when |
|---|---|---|---|
| **B1** | no client data fetch before first paint | with EVERY data read held (never answered), `main` already carries its data: no skeleton, the same rows, empty states and error surfaces, and no fewer content-bearing text elements than once answered | `redirect-only` |
| **B2** | the skeleton has the final layout's shape | the route's own loading state, painted by a soft navigation whose data response is held, and the page it becomes score ≤ **0.02** on a CLS-style formula — over the outline AND each skeleton block against the region that replaced it, bottom edge included unless that region is an open-ended list — and, where either sets two or more blocks side by side, the same number | `redirect-only`; `no-loading-boundary` — no `loading.tsx` anywhere in the chain (T1 reports that absence) |
| **B3** | no empty state while pending | with the shell's reads answered and every read of the page's own held, `main` shows no empty state (`@repo/ui/empty`, `DataTable`'s empty row) beyond what the answered render shows | `redirect-only` |
| **B4** | error ≠ empty ≠ endless skeleton | with every read answered **500** — on the cold load AND on the stale refetch a prefetched region makes later — `main` never keeps a skeleton or `aria-busy`, never shows an empty state the answered render does not, and never drops content without an error surface in its place | `redirect-only` |
| **B5** | one failing read takes down one region | each of the page's OWN reads, failed alone (and proven failed), never brings up the route's error page or leaves `main` blank with no error surface; with two or more such reads, it also leaves text outside an error surface | `redirect-only` |
| **B6** | live by default (maintainer ruling, ADR 0005 Q3) | a change made elsewhere appears without reload within the stream's latency budget; no `refetchInterval` / `setInterval` data poll (`check:no-polling`) | — |

**A "read" is a server-action POST or a call to the read router (`/{org}/~/rpc/…`).** Those are the two
transports a console page reads data over, and the only requests B1–B5 hold or fail. A navigation's
RSC payload, `/api/auth/*`, static chunks and the change stream (`/{org}/~/events`, any request sent
with `Accept: text/event-stream`, and its `?probe=1`) pass through untouched — the stream stays open for
the life of the page, so counting it would make every route "fetch on mount" (#6178). A read over any
other transport — a bare `fetch("/api/…")` — is invisible to the family; that is its stated bound.

**Every verdict is a COMPARISON with the same route answered.** An absolute reading is wrong both ways:
a static banner with `role="alert"` is not an error the reads caused, and a label is not an empty
state. Only what changes between the disturbed render and the answered one is attributed to the reads.
An empty state is recognised by its MARKUP — `data-slot="empty"`, or `DataTable`'s empty row (one body
row whose single cell spans the table) — never by its wording: the first cut matched phrases, and read
labels such as "No limit" as empty copy. The cost of comparing is the one render a comparison cannot
read: **a route whose answered render is its own empty state** looks the same whether the empty answer
came from the server or from a client read that has not answered. B1, B3 and B4 report it **NOT
MEASURED `answered-empty`** — never PASS — and the spec runs in an organisation of its own **seeded with
two rows in every list** so that as few routes as possible answer empty. The persona's organisation
cannot be used: `routes.spec.ts` keeps it empty for T5.

**B1's subject is the server render, because the held page may never hydrate.** Measured on the jobs
slice: the first server action the shell sends is held, hydration stalls behind it, and what the user
sees is the server HTML. Two things a CORRECT page renders differently there are not compared:
`aria-busy` (every filtered list's server render is busy by design — `useFilterUrlSync` reports the URL
unread until mount, #4980) and clock, date and initials text (it waits for hydration by design,
`ClockSlot`). The text check therefore counts only CONTENT-bearing elements — four letters or more, no
digit, no relative time — and fails only when the held render has FEWER of them. Both excluded signals
stay in the evidence (`heldRender.busy`, `onlyAnswered` / `onlyHeld`). The first calibration run failed
the jobs slice on exactly those two, which is how they were found.

**One classifier tells the page's reads from the shell's, for B3, B4 and B5 alike** (`shellClassifier`).
It classifies the KEY, whichever load made it: a read is the shell's when the build's server-reference
manifest places it in every page under the route's shells AND another route was seen making it in any
load — or when every route under those shells made it — or, for a READ-ROUTER read (which has no
manifest entry), when one of the route's layouts reads that procedure: `[org]/layout.tsx` seeds
`workspace.*` for the shell (#6114), and the client makes those reads only when they go stale, on B4's
refetch, on every route. Before this rule B4 PASSed the support routes on failed `workspace.*` refetches
alone (found importing run 40474520273, which was not imported). Classifying only the reads of a route's warm
answered load let the shell reads its COLD B3 and B4 loads made count as the page's: B4 PASSed five
`~/support*` routes on nothing but a failed shell action (#6180's fourth review). Phase 1 therefore
loads every route twice — answered, and cold in a context of its own — so a shell read only a fresh
session makes is on record for every route before any is classified, whatever order the tests run in.
Reference is not use: `app-shell.tsx` imports `useJobsQuery` → `getJob`, so `getJob` is in every AppShell
bundle while only `~/jobs/[id]` calls it, and the reference-only rule called it "shell" and turned that
route's B4 FAIL into NOT MEASURED (#6180's third review). The classifier needs every route's reads, so the
spec loads every route ANSWERED first (phase 1), checks the manifest against what it observed — an
action a route made that the manifest does not place on that route's page fails the run closed, which
is what a manifest from another build or with renamed worker keys does, and so does a run that observed
no action at all — and only then measures. A failed check WITHHOLDS B3, B4 and B5 for the whole run (the
state persists across worker restarts), so the artifact carries no verdict built on that manifest, and
the import refuses the scored cells it would turn NOT MEASURED.

**B3 and B4 count only the PAGE's reads.** A route on which no read of its own was held (B3) or failed
(B4) is **NOT MEASURED `no-page-reads`**, as for B5 — the first cut PASSed routes that exercised nothing
but their shell. The classification is the build's server-reference manifest, the same for all three
predicates, and the spec refuses to score at all when the manifest is missing: a fallback would count
every shell read as the page's. A route's read set is the UNION of every load phase 1 makes of it, so a
read that one cold load happened not to fire does not turn a scored cell into NOT MEASURED.

**B3 is measured on a HYDRATED page.** Holding every read (B1's load) stalls hydration, so an empty
state a client component renders after it mounts — while its read is still pending — never appears
there, and B3 used to PASS it. B3's load answers the reads the build's server-reference manifest places
in the route's shells and holds every other one, so the page hydrates and its own reads stay pending.
One limit is the browser's, not this instrument's: Next sends server actions one at a time, so the
first held action keeps every later action from being SENT. Held or never sent, none answers — which is
the condition B3 asks about.

**B2 is not the browser's CLS, because the browser's CLS cannot see a skeleton swap.** Layout
Instability scores elements that exist in both frames and MOVE; a loading fallback replaced by the page
moves nothing — the old nodes are removed and new ones inserted — so it scores 0 for any skeleton at
all. B2 tags every element of the painted loading state (captured once it has held still for 600ms, so
a nested boundary half-way through resolving is not the frame measured), releases the held response,
and compares what the skeleton occupied with what replaced it, with CLS's own formula — union area as
a fraction of the viewport, times the furthest an edge moved as a fraction of the viewport's larger side:

- **the outline** — top, left and right edges. The shell pins those on most routes, so on its own it
  scored exactly 0 on 33 of 36 routes in the first run, and a 494px panel skeleton that became a 96px
  card PASSED (#6180's review);
- **every skeleton block** (bordered or filled, at least 64px tall and a fifth of the region wide)
  against the final block that overlaps it most, or, where the page drew no frame there, the text that
  replaced it — **with the bottom edge**, because a block of the wrong height moves everything below it.
  The bottom edge is excluded only where the replacing region is an **open-ended list** (it holds table
  body rows or list items): no skeleton can know how many rows the answer has, and two rows under an
  eight-row skeleton move nothing above them. A skeleton block nothing replaced scores as vanishing;
- **a skeleton with no block at all** — thin bars only — as ONE block: its whole outline against the
  page's, bottom included unless the page ends in an open-ended list. Without it the score fell back to
  the shell-pinned outline and `~/support/abuse` PASSED with its bottom edge 241px off (#6180 re-review).

The score is the worst of those, and between two swaps the worse one is reported — the higher score
when both pass. The column rule stands beside it: when either frame sets two or more
blocks side by side, the counts must agree (F007). The swap is driven twice and the worse result is the
verdict — `~/settings/general` flipped between runs on one capture. The origin of the navigation is
chosen so that the fallback painted is the route's OWN loading boundary: it shares every segment with
the route above that boundary and differs at it. When the loading state never paints while the
response is held, B2 is NOT MEASURED saying so. **What B2 does not see**, stated: an open-ended list
whose rows are the wrong shape, and a missing row above a matching block only through that block's move.

**Hosted-only pages are not measured by B2 here.** The release gate boots a SELF-MANAGED console. It
never renders the hosted product's upsell on the plan-gated routes (`~/alerts`, `~/runners`,
`~/settings/teams`, `~/settings/sso` — F021), and on `~/settings/billing` and `[project]/usage` it renders
a "Self-managed deployment" notice in place of the panels their skeletons were drawn for. On those six
B2 is **NOT MEASURED `hosted-only`**, never scored against a page the hosted
product would not show. B1, B4 and B5 on billing and usage stay scored: they measure the self-managed
render that ships, not the hosted panels. `~/usage`'s B2 is scored too, by decision: its skeleton over
the self-managed notice is what every self-managed user sees on that route. Measuring it needs a release-gate leg that boots the console as the
hosted edition; no such leg exists today, and the plan-gating design (#6132) is its owner.

**B4 has two phases because a prefetched region makes no read on its cold load.** Failing its reads
there proves nothing about it; what it does later is refetch, on focus once stale and on its own
interval. So the page's clock is moved six minutes — past every `staleTime` the console sets — and the
page is told it is visible again, and whatever the refetch fails into is the second phase. Without it,
"render the empty state on error" on the jobs slice would PASS forever. A route on which NO read was
failed in either phase is **NOT MEASURED `no-reads-failed`**: nothing was forced to fail.

**B5 fails the page's reads, not the shell's, and proves each failure happened.** A server action the
build's server-reference manifest lists under EVERY page entry beneath the same shells is the shell's —
a layout's client graph is bundled into every page under it — and so is any read every route under
those shells made in the run (the intersection; over every route when fewer than three share the
chain). Each failure load COUNTS the 500s it served; a read the run saw once and that load never made
fails nothing. So:

- a route with **no read of its own** is **NOT MEASURED `no-page-reads`** — its regions are
  server-rendered, and no failure of its own can be injected from the browser;
- a route on which **no failure was intercepted** is **NOT MEASURED `not-intercepted`**;
- a route with **one** read of its own is measured too: failing it must not bring up the route's
  `ErrorState` or leave `main` with no text and no error surface (a skeleton that never resolves —
  `~/settings/general`, F050/F051);
- with **two or more**, a failure must also leave text outside an error surface: its siblings were fed
  by reads that answered.

"The route's `ErrorState`" is read from its class signature, which is unambiguous because
`tests/components/errors/error-state-placement.test.tsx` holds `ErrorState` to route boundaries — with
one recorded exception, `~/jobs/jobs-client.tsx` (#6121), whose in-region `ErrorState` B5 would read as
the route's. That page has no read of its own for B5 to fail today, so the exception costs no verdict.

The first cut PASSED any route with at most one read of its own — 25 of 34 PASSes, 17 of them on
routes nothing was failed on (#6180's review). A page with more than eight reads of its own is NOT
MEASURED with the count. The shell's own containment is NOT measured by B5 — a stated gap, owned by #6114.

**The instrument before the tree.** `behaviourControl()` drives every predicate, through the same
loaders and judges the routes go through, against fixture pages with known answers — a page that must
PASS and, per predicate, pages one defect away that must FAIL: a client fetch on mount; an empty state
while pending, and one that appears only after hydration; an empty state on a failed refetch; content
that vanishes with no error; a skeleton that never resolves; a failure that brings up the route's error
page, and one that blanks both regions; a skeleton with the wrong columns, one whose frame moves, and
one whose height alone is wrong, and a bars-only skeleton over a taller page. A shorter open-ended list,
a `RegionError` with no `role`, a page with no reads and a page whose only read is its shell's (both NOT
MEASURED, never PASS — the shell read classified through a fixture build manifest, by the same parser)
are its other known answers — and a page read made over a server ACTION that every page entry
references but only this page calls, which must be MEASURED (B4 FAIL), never classified away. Every
NOT MEASURED the control expects is asserted with its REASON, so an instrument that cannot intercept
server actions — and reads `no-reads-failed` where `no-page-reads` was meant — goes red. A predicate the control names is
withheld for the whole run. Then the **jobs slice** — ADR 0005's reference page — must PASS B1, B3, B4
and B5, and must be MEASURED on B2, which it FAILS: its skeleton has no PageToolbar row and a one-row
filter bar, so the table frame paints about 100px above where the page puts it. That is debt (#6121),
not a calibration gap — the first, outline-only B2 could not see it. B1, B2 and B4 must also have
produced a PASS or a FAIL on at least ten routes.

**B3 and B5 are floored by witness, not by count** (#6318). They can only measure a route that makes a
read of its own on load, and ADR 0005 moves first-paint reads onto the server prefetch, so their
measurable set shrinks with every correct migration — a count floor had to be lowered by hand each time.
Instead, B4's cold load (an independent load that fails every read and records which were the page's)
witnesses which routes read on load. Every witnessed route must be scored on B3 and B5, with one excuse
per predicate that is a fact about the page: B3 may read `answered-empty` (the answered render is its own
empty state), and B5 may read `over-read-budget`. An unwitnessed route may read `no-page-reads` (B5 also
`not-intercepted`). Any other NOT MEASURED, a thrown load or a withheld predicate, fails the floor. A B4
that was withheld or not measured witnesses nothing, and a withheld B4 still carrying evidence fails the
floor outright. In each shell, a control route that reads `members.list` on load by design (the
`~/jobs` and `[project]/jobs` lists) must be witnessed and scored. So a scan that stops seeing reads
cannot pass by seeing none, and a fault confined to one shell cannot pass by dropping that shell's
routes from the witness and the verdicts together. The witness and the verdicts share the shell
classifier (`shellReadsFor`), the read carrier (`readCarrier`) and the read key (`readKey`). A fault in
them that spares every control's reads is out of this floor's reach. The fixture control drives all
three together and covers that. B3 and B4 are
judged after every route's loads have been taken, so each route is classified against the same
evidence whatever its position in the manifest.

**A scored cell may not quietly stop being scored.** The count floor cannot see a single cell going
from PASS to NOT MEASURED, so `--import-live` compares the new records with the committed ones cell by
cell and refuses an import in which a cell that was PASS or FAIL becomes NOT MEASURED or disappears,
unless `--explain=<file>` names it with a reason. This is a check at import time, not a ratchet on the
scores: a verdict may still move from PASS to FAIL, and the ledger below is what records that.

**A route that FAILS a B predicate does not fail its test.** The verdict reaches the scoreboard through
`--import-live`, where `apps/console/scripts/audit-report.mjs` holds every B FAIL to a per-route ledger,
`BEHAVIOUR_LEDGER`, with CLAUDE.md §6's two kinds of row: `lifts: "#n"` is measured debt the named lane
removes; `reason:` is a decision. Both directions are checked — a FAIL with no row and a row whose cell
no longer fails are both errors. It is a ledger, not a ratchet: it records what fails, and nothing in it
stops a PASS from becoming a FAIL except the row that FAIL then has to gain.

## The scoreboard and the ratchet

**Both halves are built** — the static one in #3618, the live one in #3634.
`apps/console/scripts/audit-report.mjs` generates [`scoreboard.md`](./scoreboard.md) and
`apps/console/ui-conformance-baseline.json`: `pnpm -F console audit:report --write` regenerates
them, a bare `pnpm -F console audit:report` checks them against the tree and exits 2 naming the
command — the contract `PROGRAMME.md`'s derived half uses. Never hand-edit either file.

**The live half is measured in CI and committed, not inferred.** TWO Playwright projects write
THREE files — `test-results/ui-audit.json` (T5, T6, R1–R7, as the run's own owner in a fresh empty
org), `test-results/ui-audit-permissions.json` (T7, as the `member` persona in a *second*
organisation) and `test-results/ui-audit-interaction.json` (F8–F10 and R8, from the
`audit-interaction` project, which ACTIVATES controls rather than reading rendered state) — and
`node apps/console/scripts/audit-report.mjs --import-live=<dir> --run=<url> --commit=<sha>` reduces
them to `apps/console/ui-conformance-live.json`. **They are joined, never pooled**: each artifact
declares the predicates it may carry, and a record in the wrong one refuses to parse.
`e2e/audit/report.ts`'s header records what pooling them cost the first time.

> This paragraph said "the Playwright `audit` project writes two files" from #3634 until #4901, and
> the third one had existed since #4277. That is the gap the sentence itself caused: the
> `audit-interaction` leg ran in the release gate for weeks, and because nothing the reader saw said
> there was an artifact to import, nobody imported it — so all 160 F8/F9/F10/R8 cells read NOT
> MEASURED, on a board whose headline was 1029 PASS against 32 FAIL. The first import (run
> 35713083980 @ `c776a4d15`) turned 141 of them into verdicts and found seven FAILs. **A missing
> instrument is loud; an instrument nobody joined in is silent, and looks exactly like a clean one.**

A (route, predicate) cell no artifact carries is **`NOT MEASURED`** — its own column, never folded
into N/A and never a pass. `permissions.spec.ts` drives only the org-only routes, so T7 has no
record for the 13 parameterised ones; an N/A there would be a claim about the page, and rule 2 above
forbids one that is not derivable from the route record. `NOT MEASURED` is a claim about the
instrument, which is what #3854 built it for. It leaves the denominator exactly as an N/A does, so a
predicate withheld everywhere scores `null`, never `1`.

- One row per route, one column per family, plus a per-predicate **N/A count**.
- A route's score **may never fall**. A new route starts at the current floor, not at zero — landing
  a page that scores 0 must not be easier than improving one that scores 0.6.
- The baseline is captured on an **unmodified `dev`** before any conformance lane changes a
  component (#3618 for the static families, #3634 for the live ones). A guard shipped in the same
  commit as its fix is tautological, and this repo has paid for that more than once.
- A lane's PR must move a number **in the same commit** as its code. A lowered baseline with no code
  change, or a code change that moves no number, is wrong in one direction or the other.

**The scoreboard is a report; it is not a third baseline.** The two files that ratchet are
`apps/console/route-states-baseline.yaml` and `apps/console/shared-surface-allowlist.yaml`. The
scoreboard joins them to a route, which neither of them does — both are per file and per predicate,
so "which pages are worst" was an impression until it existed.

### What the generator found that this file did not say

Three gaps, each now owned — and all three now closed. They are recorded here because a rubric
that does not name its own blind spots reads as a rubric that has none.

- **H3 has no instrument** (#3797) — **closed**. `check-shared-surface.mjs`'s `status_badge` rule
  scores it with two matchers: the `vx-status` class token, which means the badge's markup was
  rebuilt by hand, and a SECOND DEFINITION of the status vocabulary — two consecutive entries of one
  object literal both keyed on a word the badge already maps, with the vocabulary derived from
  `packages/ui/src/status-badge.tsx` on every run. What that unit found is that this sentence had
  the shape of the defect wrong too: the rule's negative form is not "a `<Badge>` plus a local
  colour map" (an object literal a token scan cannot tell from any other) but those two token
  shapes, which ARE greppable. It measured 7 occurrences in 3 files on an unmodified `dev`; #4295
  removed all three and the rule's ledger is empty.
- **F1–F7 had no instrument at all** (#3796) — **closed**. `scripts/check-filter-standard.mjs`
  now scores F1–F6 over the console's fifteen filter SURFACES, and
  `apps/console/tests/lib/queries/filter-standard-facets.test.ts` measures F7 by running every
  facet-bearing server builder. What that unit found first was that this sentence had the shape of
  the defect wrong: the standard was implemented across fifteen surfaces and UNMEASURED, not
  absent — and an un-instrumented cell and an empty one render the same dash.
- **The empty-state matcher mapped to no predicate** (#3798) — **now H9**.
  `check-shared-surface.mjs`'s `empty_state` rule guards CLAUDE.md §6's `@repo/ui/empty` row and
  found 18 occurrences on an unmodified `dev`, and the H table above had no row for it because this
  file assigns the *rendered* empty state to **T5**, which it declares live. The scoreboard counted
  those 18 in its reconciliation and scored them nowhere. #3634 closed it by giving the static
  question its own row rather than by folding two instruments into one verdict.

Nothing runs the generator in CI yet (#3799) — the same hand-off #3616 left to #3759 for the
route-state gate, and named for the same reason: a check nothing invokes reports green by never
running.
