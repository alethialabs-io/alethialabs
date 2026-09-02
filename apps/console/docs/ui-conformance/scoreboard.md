<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The console UI conformance scoreboard

Every **private** console route, scored against the static half of
[`RUBRIC.md`](./RUBRIC.md).

**Everything below the marker is generated. Do not edit it.**
Run `pnpm -C apps/console run audit:report --write` and commit the result; a bare
`pnpm -C apps/console run audit:report` checks the two generated artifacts against the tree and exits 2
naming the command, the same contract `PROGRAMME.md`'s derived half uses. The machine-readable
twin is [`apps/console/ui-conformance-baseline.json`](../../ui-conformance-baseline.json).

## What this is, and what it is not

**It is a report, not a baseline.** Two files are the source of truth for console conformance and
this is neither of them:

- `apps/console/route-states-baseline.yaml` — the S1–S4 / T1–T4 ratchet, checked in both
  directions as a set of named routes by `scripts/check-route-states.mjs`;
- `apps/console/shared-surface-allowlist.yaml` — the H-family ledgers, `baseline:` for recorded
  decisions and `debt:` for measured drift, checked in both directions by
  `scripts/check-shared-surface.mjs`.

This file joins them to a **route**, which neither of them does: both are per-file and
per-predicate, so "which pages are worst" was an impression rather than a number. If you find
yourself wanting to record a fact here that neither of those two files holds, that fact belongs in
one of them.

## How to read a cell

`score = PASS ÷ (PASS + FAIL)`. **N/A leaves the denominator**, which is why the N/A count is a
column of its own: a predicate whose N/A count grows is a predicate being escaped, and escaping one
makes a page's score go *up* with nothing red anywhere.

A `—` means **not instrumented**, never "passed" and never "nothing found". The generator refuses
to run unless every predicate the rubric defines lands in exactly one of *scored here*, *live*, or
*un-instrumented with an owning issue* — so a predicate cannot fall out of this report quietly, and
adding a row to the rubric makes this file refuse to regenerate until somebody says which it is.

## How a shared-surface occurrence becomes a route's verdict

The H family is measured per **file**; a route is a **page**. The join is the page's own module
closure — every `@/…` or relative import reachable from its `page.tsx`, transitively.

The **layout chain is deliberately not in it**. Adding the layouts pulls in `AppShell` → the
sidebar → the org switcher → very nearly the whole console: every route's closure lands between
477 and 563 files and the H column stops telling one page from another. Page-only closures run from
1 to 383. The S family already measures the shell, which is the half a layout owns.

The cost of that choice is stated rather than left to be discovered: a defect living **only** in
the shared chrome is in no route's H column. It is not invisible — the reconciliation section
counts it and `ui-conformance-baseline.json` names every file — but it is not scored, because
attributing the sidebar's drift to all 40 routes would say the console is 40 times worse than it is,
and would move all 40 numbers when one file is fixed.

An occurrence is a defect unless a **`reason:`** entry in the allowlist covers it. A **`lifts:`**
entry does *not* excuse it: `lifts:` is measured drift a named lane will remove, and RUBRIC.md says
so for H8 in as many words — "a page scores FAIL on H8 today and the number can only shrink."

## Why the baseline below was measured before anything was fixed

The numbers this file was committed with were measured on an **unmodified `dev`**, before any
conformance lane changed a component. A guard shipped in the same commit as its fix is
tautological, and this repo has paid for that more than once. Every conformance lane that follows
lowers a number here in the same commit as its code.

<!-- BEGIN GENERATED: audit-report · tree-derived · DO NOT EDIT BELOW -->

## What this scored

**40 private routes** · 4 redirect-only · 36 real pages.

RUBRIC.md defines **33 predicates**. This report scores **15** of them.
10 are live and land here with #3634; 8 have no instrument anywhere today.

| source | what it contributes |
|---|---|
| `scripts/lib/console-routes.mjs` | the route set — the denominator of every number below |
| `scripts/check-route-states.mjs` | S1–S4, T1–T4, per route |
| `apps/console/route-states-baseline.yaml` | the ratchet those eight predicates are held to |
| `scripts/check-shared-surface.mjs` | every H-family occurrence, per file |
| `apps/console/shared-surface-allowlist.yaml` | which occurrences are a recorded decision (`baseline: 16`) and which are measured drift (`debt: 133`) |
| `apps/console/docs/ui-conformance/RUBRIC.md` | the predicate set itself, read out of its own tables |

## Which predicates have an instrument

An un-instrumented predicate is rendered `—` everywhere below, never as a pass and never
omitted. The generator refuses to run unless every rubric predicate lands in exactly one row
of this table.

| family | predicates | scored here | live (#3634) | no instrument |
|---|---:|---:|---:|---:|
| **S** — shell & width | 4 | 4 | 0 | 0 |
| **T** — states | 7 | 4 | 3 | 0 |
| **H** — shared surface | 8 | 7 | 0 | 1 |
| **F** — filter standard | 7 | 0 | 0 | 7 |
| **R** — rendered integrity | 7 | 0 | 7 | 0 |
| **total** | 33 | 15 | 10 | 8 |

The un-instrumented eight, each with the issue that owns it:

| id | owner | what is not being measured |
|---|---|---|
| **H3** | #3797 | StatusBadge. `check-shared-surface.mjs` records why this row stays prose: a page that should have shown a status pill and showed a `<Badge>` has no negative form to grep for. |
| **F1** | #3796 | the filter standard — a `createFilterStore` store exists for the page. |
| **F2** | #3796 | the filter standard — `useFilterUrlSync` is wired. |
| **F3** | #3796 | the filter standard — search is debounced and the normalized query is the TanStack key. |
| **F4** | #3796 | the filter standard — the bar is built from the shared filter components. |
| **F5** | #3796 | the filter standard — the result count is a `CountPill`. |
| **F6** | #3796 | the filter standard — `keepPreviousData` plus the placeholder dim. |
| **F7** | #3796 | the filter standard — the server builder's separate unfiltered facet pass. A unit test by design, per RUBRIC.md. |

## Per predicate

`score = PASS ÷ (PASS + FAIL)`. N/A leaves the denominator, so the N/A column is first-class:
a predicate whose N/A count grows is a predicate being escaped.

| id | family | instrument | PASS | FAIL | N/A | score | N/A reasons |
|---|---|---|---:|---:|---:|---:|---|
| **S1** | S | `check-route-states` | 35 | 1 | 4 | 0.97 | `redirect-only` 4 |
| **S2** | S | `check-route-states` | 19 | 17 | 4 | 0.53 | `redirect-only` 4 |
| **S3** | S | `check-route-states` | 31 | 4 | 5 | 0.89 | `no-loading-boundary` 1, `redirect-only` 4 |
| **S4** | S | `check-route-states` | 34 | 2 | 4 | 0.94 | `redirect-only` 4 |
| **T1** | T | `check-route-states` | 32 | 4 | 4 | 0.89 | `redirect-only` 4 |
| **T2** | T | `check-route-states` | 40 | 0 | 0 | 1.00 | — |
| **T3** | T | `check-route-states` | 0 | 10 | 30 | 0.00 | `does-not-call-not-found` 30 |
| **T4** | T | `check-route-states` | 33 | 7 | 0 | 0.82 | — |
| **T5** | T | live — #3634 | — | — | — | — | — |
| **T6** | T | live — #3634 | — | — | — | — | — |
| **T7** | T | live — #3634 | — | — | — | — | — |
| **H1** | H | `check-shared-surface` | 40 | 0 | 0 | 1.00 | — |
| **H2** | H | `check-shared-surface` | 38 | 2 | 0 | 0.95 | — |
| **H3** | H | **none** — #3797 | — | — | — | — | — |
| **H4** | H | `check-shared-surface` | 40 | 0 | 0 | 1.00 | — |
| **H5** | H | `check-shared-surface` | 40 | 0 | 0 | 1.00 | — |
| **H6** | H | `check-shared-surface` | 40 | 0 | 0 | 1.00 | — |
| **H7** | H | `check-shared-surface` | 39 | 1 | 0 | 0.97 | — |
| **H8** | H | `check-shared-surface` | 8 | 32 | 0 | 0.20 | — |
| **F1** | F | **none** — #3796 | — | — | — | — | — |
| **F2** | F | **none** — #3796 | — | — | — | — | — |
| **F3** | F | **none** — #3796 | — | — | — | — | — |
| **F4** | F | **none** — #3796 | — | — | — | — | — |
| **F5** | F | **none** — #3796 | — | — | — | — | — |
| **F6** | F | **none** — #3796 | — | — | — | — | — |
| **F7** | F | **none** — #3796 | — | — | — | — | — |
| **R1** | R | live — #3634 | — | — | — | — | — |
| **R2** | R | live — #3634 | — | — | — | — | — |
| **R3** | R | live — #3634 | — | — | — | — | — |
| **R4** | R | live — #3634 | — | — | — | — | — |
| **R5** | R | live — #3634 | — | — | — | — | — |
| **R6** | R | live — #3634 | — | — | — | — | — |
| **R7** | R | live — #3634 | — | — | — | — | — |

The static H half emits **no N/A at all**, which is why those rows are empty rather than
carrying the rubric's `renders-no-table` / `renders-no-formatted-value` / `declares-no-z-index`.
A matcher cannot tell "this page has no table" from "this page's table is correct" — both are
zero findings — so claiming the N/A would shrink the denominator on evidence that does not bear
on it. Every page is asked, and a page with no table passes H4 by not hand-rolling one.

## Per route

Each cell is `PASS/scored · score` over that family's instrumented predicates —
S 4/4, T 4/7, H 7/8, F 0/7, R 0/7. `surface` is the number of console modules the
page's own import graph reaches, which is the denominator the H column was measured over.

| route | surface | S | T | H | F | R | overall |
|---|---:|---|---|---|---|---|---|
| `/cli/login` | 4 | 1/3 · 0.33 | 1/3 · 0.33 | 6/7 · 0.86 | — | — | **0.62** |
| `/[org]/[project]/architecture` | 381 | 3/4 · 0.75 | 3/4 · 0.75 | 4/7 · 0.57 | — | — | **0.67** |
| `/[org]/~/usage` | 182 | 2/4 · 0.50 | 2/3 · 0.67 | 6/7 · 0.86 | — | — | **0.71** |
| `/[org]/[project]/environments` | 234 | 2/4 · 0.50 | 3/4 · 0.75 | 6/7 · 0.86 | — | — | **0.73** |
| `/[org]/~/alerts` | 288 | 2/4 · 0.50 | 3/3 · 1.00 | 6/7 · 0.86 | — | — | **0.79** |
| `/[org]/~/jobs/[id]` | 218 | 3/4 · 0.75 | 2/3 · 0.67 | 6/7 · 0.86 | — | — | **0.79** |
| `/[org]/~/new` | 356 | 2/4 · 0.50 | 3/3 · 1.00 | 6/7 · 0.86 | — | — | **0.79** |
| `/[org]/~/runners` | 270 | 3/4 · 0.75 | 3/3 · 1.00 | 5/7 · 0.71 | — | — | **0.79** |
| `/[org]/~/settings/classification` | 145 | 3/4 · 0.75 | 2/3 · 0.67 | 6/7 · 0.86 | — | — | **0.79** |
| `/[org]/~/support` | 7 | 2/4 · 0.50 | 3/3 · 1.00 | 6/7 · 0.86 | — | — | **0.79** |
| `/[org]/[project]/clusters` | 163 | 3/4 · 0.75 | 3/4 · 0.75 | 6/7 · 0.86 | — | — | **0.80** |
| `/[org]/[project]/jobs` | 219 | 3/4 · 0.75 | 3/4 · 0.75 | 6/7 · 0.86 | — | — | **0.80** |
| `/[org]/[project]/settings/activity` | 275 | 4/4 · 1.00 | 2/4 · 0.50 | 6/7 · 0.86 | — | — | **0.80** |
| `/[org]/[project]/usage` | 146 | 3/4 · 0.75 | 3/4 · 0.75 | 6/7 · 0.86 | — | — | **0.80** |
| `/[org]` | 281 | 3/4 · 0.75 | 3/3 · 1.00 | 6/7 · 0.86 | — | — | **0.86** |
| `/[org]/~/clusters` | 162 | 3/4 · 0.75 | 3/3 · 1.00 | 6/7 · 0.86 | — | — | **0.86** |
| `/[org]/~/evidence` | 149 | 3/4 · 0.75 | 3/3 · 1.00 | 6/7 · 0.86 | — | — | **0.86** |
| `/[org]/~/jobs` | 218 | 3/4 · 0.75 | 3/3 · 1.00 | 6/7 · 0.86 | — | — | **0.86** |
| `/[org]/~/settings/billing/invoices` | 192 | 4/4 · 1.00 | 2/3 · 0.67 | 6/7 · 0.86 | — | — | **0.86** |
| `/[org]/[project]/settings/access` | 212 | 4/4 · 1.00 | 3/4 · 0.75 | 6/7 · 0.86 | — | — | **0.87** |
| `/[org]/[project]/settings/general` | 213 | 4/4 · 1.00 | 3/4 · 0.75 | 6/7 · 0.86 | — | — | **0.87** |
| `/[org]/[project]/settings/preview` | 141 | 4/4 · 1.00 | 3/4 · 0.75 | 6/7 · 0.86 | — | — | **0.87** |
| `/[org]/[project]` · | 1 | all N/A | 1/2 · 0.50 | 7/7 · 1.00 | — | — | **0.89** |
| `/[org]/[project]/settings` · | 1 | all N/A | 1/2 · 0.50 | 7/7 · 1.00 | — | — | **0.89** |
| `/[org]/~/settings` · | 1 | all N/A | 1/2 · 0.50 | 7/7 · 1.00 | — | — | **0.89** |
| `/dashboard/[[...rest]]` · | 125 | all N/A | 1/2 · 0.50 | 7/7 · 1.00 | — | — | **0.89** |
| `/[org]/~/connectors` | 208 | 3/4 · 0.75 | 3/3 · 1.00 | 7/7 · 1.00 | — | — | **0.93** |
| `/[org]/~/settings/access` | 211 | 4/4 · 1.00 | 3/3 · 1.00 | 6/7 · 0.86 | — | — | **0.93** |
| `/[org]/~/settings/activity` | 275 | 4/4 · 1.00 | 3/3 · 1.00 | 6/7 · 0.86 | — | — | **0.93** |
| `/[org]/~/settings/billing` | 191 | 4/4 · 1.00 | 3/3 · 1.00 | 6/7 · 0.86 | — | — | **0.93** |
| `/[org]/~/settings/general` | 133 | 4/4 · 1.00 | 3/3 · 1.00 | 6/7 · 0.86 | — | — | **0.93** |
| `/[org]/~/settings/members` | 219 | 4/4 · 1.00 | 3/3 · 1.00 | 6/7 · 0.86 | — | — | **0.93** |
| `/[org]/~/settings/roles` | 222 | 4/4 · 1.00 | 3/3 · 1.00 | 6/7 · 0.86 | — | — | **0.93** |
| `/[org]/~/settings/sso` | 211 | 4/4 · 1.00 | 3/3 · 1.00 | 6/7 · 0.86 | — | — | **0.93** |
| `/[org]/~/settings/teams` | 212 | 4/4 · 1.00 | 3/3 · 1.00 | 6/7 · 0.86 | — | — | **0.93** |
| `/[org]/~/support/ask` | 197 | 4/4 · 1.00 | 3/3 · 1.00 | 6/7 · 0.86 | — | — | **0.93** |
| `/[org]/~/support/my-cases` | 147 | 4/4 · 1.00 | 3/3 · 1.00 | 6/7 · 0.86 | — | — | **0.93** |
| `/[org]/~/support/cases/[id]` | 155 | 4/4 · 1.00 | 3/4 · 0.75 | 7/7 · 1.00 | — | — | **0.93** |
| `/[org]/~/support/abuse` | 134 | 4/4 · 1.00 | 3/3 · 1.00 | 7/7 · 1.00 | — | — | **1.00** |
| `/[org]/~/support/submit` | 144 | 4/4 · 1.00 | 3/3 · 1.00 | 7/7 · 1.00 | — | — | **1.00** |

`·` marks a redirect-only route: no JSX, a `redirect()` call. It is N/A for six of the eight
route-state predicates and passes the H rows on a closure of one file that renders nothing.

## Where every shared-surface occurrence landed

`check-shared-surface` found **699 occurrences across 130 files**. This section
accounts for all of them twice — once by ledger, once by reach — so a rule or a file falling out
of the scoreboard cannot be quiet.

| rule | predicate | total | recorded decision | measured drift | unlisted | in a page's surface | shared chrome only | outside the private tree |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `data_table` | H4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `empty_state` | **none** — #3798 | 9 | 0 | 9 | 0 | 8 | 1 | 0 |
| `format` | H5 | 6 | 6 | 0 | 0 | 3 | 3 | 0 |
| `layer_token` | H7 | 1 | 0 | 1 | 0 | 1 | 0 | 0 |
| `page_title` | H1 | 17 | 17 | 0 | 0 | 7 | 1 | 9 |
| `section_header` | H2 | 4 | 0 | 4 | 0 | 3 | 1 | 0 |
| `stat_strip` | H6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `type_scale` | H8 | 662 | 1 | 661 | 0 | 484 | 152 | 26 |
| **total** | | 699 | 24 | 675 | 0 | 506 | 158 | 35 |

**`unlisted` is the column to read first.** A non-zero value means the guard is red — an
occurrence neither a `reason:` nor a `lifts:` entry accounts for. It is not a defect of this
report; run `pnpm check:shared-surface`.

**`empty_state` maps to no rubric predicate** (#3798). CLAUDE.md §6's EmptyState row. RUBRIC.md's H table has no row for it — the rubric files the empty state as T5, which it declares LIVE. The static matcher asks a different question (does this file hand-roll a centred empty region?), so reporting it as T5 would be one instrument reported as another. Counted in the table above, scored nowhere.

**Reachable only from the shared layout chain** — 35 files. These are real
occurrences in the sidebar, topbar, breadcrumbs and shells that every route renders. They are not
in any route's H column, because attributing the chrome's drift to all 40 routes would say the
console is 40 times worse than it is. The full list is in `ui-conformance-baseline.json`.

**Outside every private route's module graph** — 8 files. Public routes (sign-in,
onboarding, OAuth consent, accepting terms) and modules no private page imports. The route manifest
is scoped to `app/(private)`, so these are outside the rubric's stated subject and are listed here
rather than scored:

| file | occurrences |
|---|---:|
| `apps/console/components/auth/onboarding-form.tsx` | 19 |
| `apps/console/components/auth/auth-form.tsx` | 5 |
| `apps/console/components/forms/oauth-consent-form.tsx` | 4 |
| `apps/console/components/design-project/container-platform-selector.tsx` | 3 |
| `apps/console/app/(public)/onboarding/page.tsx` | 1 |
| `apps/console/components/agent/chat-top-bar.tsx` | 1 |
| `apps/console/components/design-project/canvas/nodes/zone-node.tsx` | 1 |
| `apps/console/components/legal/accept-terms-form.tsx` | 1 |

_Generated by `apps/console/scripts/audit-report.mjs`. Do not edit below the marker — run `pnpm -C apps/console run audit:report --write`._

<!-- END GENERATED: audit-report -->
