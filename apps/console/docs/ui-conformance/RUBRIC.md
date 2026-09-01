<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The console UI conformance rubric

Twenty-five predicates over every **private** console route. This file is the contract: the static
checks, the live Playwright `audit` project and the scoreboard generator all implement predicates
defined *here*, and none of them may invent one.

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
| **T3** | `notFound()` has a `not-found.tsx` in its own chain | the page calls `notFound()` and the nearest `not-found.tsx` is scoped to the same resource | `does-not-call-not-found` |
| **T4** | the page declares metadata | `hasMetadata` — on the page, or on its own layout for a client page | never — a redirect still owns a title |
| **T5** | the empty state renders through `EmptyState` | driven against an empty org, the rendered empty region resolves to `@repo/ui/empty` | `no-empty-state` (the page has no list, tab or panel that can be empty) |
| **T6** | the error state renders through the shared error component | fault-injected, the page renders `components/errors/error-state` | `redirect-only` |
| **T7** | permission-denied renders a real state | as the `member` persona, a forbidden page renders a deliberate state, not a blank | `no-restricted-surface` |

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

**T3 is about the resource, not the file.** 38 of 40 private routes resolve to `[org]/not-found.tsx`
— including every project-scoped route, so a bad *project* slug answers "Organization not found… or
you don't have access". The nearest boundary existing is not the predicate; the nearest boundary
naming the right thing is.

## Family H — the shared surface  ·  static

Each row is a row of CLAUDE.md §6's table. H1 is guarded today; H2–H7 are what unit #3615 adds.

| id | predicate | PASS when | N/A when |
|---|---|---|---|
| **H1** | the page title comes from `PageHeader` | no raw `<h1>` outside the allowlist | `redirect-only` |
| **H2** | every section heading comes from `PageHeader level={n}` | no raw `<h2>`/`<h3>` outside the allowlist | `redirect-only` |
| **H3** | status renders through `StatusBadge` | no local status→variant map, and no raw `.vx-status` re-implementation | `renders-no-status` |
| **H4** | tabular data renders through `DataTable` or `@repo/ui/table` | no header row over repeated `grid-cols-[…]` row children | `renders-no-table` |
| **H5** | every number, date, size and amount goes through `@repo/format` | no `toFixed`, `toLocale{Date,Time}String`, `/1024`, hand-written currency symbol, or local `format*` duplicating a `@repo/format` export | `renders-no-formatted-value` |
| **H6** | no stat-card strip | no row of bordered label-over-number cells | `redirect-only` |
| **H7** | no bare numeric z-index | every `z-*` is a `--z-*` token from `packages/brand/src/tokens.css` | `declares-no-z-index` |

**H5's hardest case is the one a grep cannot reach.** `billing/billing-checkout-form.tsx:118` builds
`${symbol}${n.toLocaleString("en-US")}` where `symbol` is a **variable**, and
`agent/approval-card.tsx:154` takes `prefix="$"` as a **prop**. The existing `$${` matcher can never
fire on either. A predicate that only tests the shapes the current guard can see would score both
pages PASS, which is worse than not asking.

## Family F — the filter standard  ·  static, plus one unit test

N/A for every page that is not a list page — declared reason `not-a-list-page`, derivable from the
absence of a `lib/stores/use-*-filters.ts` store, not from how the page looks.

| id | predicate | PASS when |
|---|---|---|
| **F1** | a `createFilterStore` store exists for the page |
| **F2** | `useFilterUrlSync` is wired, so a filtered view is linkable |
| **F3** | search is debounced and the **normalized** query object is the TanStack key |
| **F4** | the bar is built from `FilterBar` / `FilterSearch` / `FacetFilter` / `FilterChipGroup` / `FilterBarReset` |
| **F5** | the result count is a `CountPill` beside the heading — never "N of M" prose in the bar |
| **F6** | `keepPreviousData` plus the `opacity-60` dim on `isPlaceholderData` |
| **F7** | the server builder issues a rows pass **and a separate unfiltered facet pass** |

**F7 is a unit test, not a matcher.** A facet's counts must come from the unfiltered universe: filter
in memory and the option you just picked disappears from the list, which makes the filter bar
un-un-selectable. "A facet pass sees only the scope predicates" is a behaviour, and the only honest
way to assert it is to run the builder against a fixture and check the second query's predicates.

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
| **R5** | axe reports zero serious or critical violations | `scanA11y()` returns none at `wcag2a`/`wcag2aa` | never |
| **R6** | zero console errors, zero failed requests | nothing on `console.error`, no response ≥ 400 | never |
| **R7** | interactive within budget | p95 under the route's recorded budget | never |

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

**R5 needs one thing fixing before it can be believed.** `e2e/helpers/a11y.ts` currently returns `[]`
when `@axe-core/playwright` cannot be imported. A silent empty result is indistinguishable from a
clean page — it must raise.

---

## The scoreboard and the ratchet

⚠️ **NOT BUILT YET.** Neither `scoreboard.md` nor a `pnpm -F console audit:report` script exists in
the tree today — this section is the contract the generator must satisfy when it lands, not a
description of something you can run. It is written in the future tense deliberately: an earlier
draft described both in the present tense, which sent a reader looking for a file and a script that
have never existed, and this file is not in `check-docs-contract.mjs`'s `DOCS` list, so nothing
would have caught the drift.

When it lands: `apps/console/docs/ui-conformance/scoreboard.md` will be generated by
`pnpm -F console audit:report` and CI will diff-gate it, the same contract `PROGRAMME.md` uses.
Never hand-edit it.

- One row per route, one column per family, plus a per-predicate **N/A count**.
- A route's score **may never fall**. A new route starts at the current floor, not at zero — landing
  a page that scores 0 must not be easier than improving one that scores 0.6.
- The baseline is captured on an **unmodified `dev`** before any conformance lane changes a
  component (#3618 for the static families, #3634 for the live ones). A guard shipped in the same
  commit as its fix is tautological, and this repo has paid for that more than once.
- A lane's PR must move a number **in the same commit** as its code. A lowered baseline with no code
  change, or a code change that moves no number, is wrong in one direction or the other.
