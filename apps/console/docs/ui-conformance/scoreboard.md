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

RUBRIC.md defines **44 predicates**. This report scores **43** of them —
24 from the tree and 19 from the committed live audit records.
1 has no instrument anywhere today.

| source | what it contributes |
|---|---|
| `scripts/lib/console-routes.mjs` | the route set — the denominator of every number below |
| `scripts/check-route-states.mjs` | S1–S4, T1–T4, per route |
| `apps/console/route-states-baseline.yaml` | the ratchet those eight predicates are held to |
| `scripts/check-shared-surface.mjs` | every H-family occurrence, per file |
| `scripts/check-filter-standard.mjs` | F1–F6 per filter SURFACE, joined to the routes whose closure reaches it |
| `apps/console/tests/lib/queries/filter-standard-facets.test.ts` | F7 — the behaviour RUBRIC.md says a matcher cannot answer |
| `apps/console/shared-surface-allowlist.yaml` | which occurrences are a recorded decision (`baseline: 15`) and which are measured drift (`debt: 0`) |
| `apps/console/ui-conformance-live.json` | T5–T7, R1–R8, F8–F10 and B1–B5 as MEASURED, imported from a CI run of the Playwright `audit` and `audit-interaction` projects |
| `apps/console/docs/ui-conformance/RUBRIC.md` | the predicate set itself, read out of its own tables |

## Which predicates have an instrument

An un-instrumented predicate is rendered `—` everywhere below, never as a pass and never
omitted. The generator refuses to run unless every rubric predicate lands in exactly one row
of this table. A **live** predicate is instrumented: it is measured in a browser by the
Playwright `audit` project and joined in from the committed records, not inferred from the tree.

| family | predicates | static | live | no instrument |
|---|---:|---:|---:|---:|
| **S** — shell & width | 4 | 4 | 0 | 0 |
| **T** — states | 7 | 4 | 3 | 0 |
| **H** — shared surface | 9 | 9 | 0 | 0 |
| **F** — filter standard | 10 | 7 | 3 | 0 |
| **R** — rendered integrity | 8 | 0 | 8 | 0 |
| **B** — behaviour | 6 | 0 | 5 | 1 |
| **total** | 44 | 24 | 19 | 1 |

The un-instrumented one, with the issue that owns it:

| id | owner | what is not being measured |
|---|---|---|
| **B6** | #6115 | live by default — a change made elsewhere appears without reload, and no data poll remains; the instrument is the real-time bus and `check:no-polling`. |

## The live half — 4 artifacts, 4 questions, never pooled

T5–T7, R1–R8, F8–F10 and B1–B5 are measured in a browser, not read off the tree. The records below were
imported from **https://github.com/alethialabs-io/alethialabs/actions/runs/40485396792** at commit `3b8a1fffbd1e6f661c5d275e342216c0ba55f7b3` and committed to
`apps/console/ui-conformance-live.json`; refresh them with `--import-live`. They come from **4 files, joined and never
pooled** — `e2e/audit/report.ts` records what pooling them cost, and the split is checked here:
each section declares the predicates it may carry, and a record in the wrong one refuses to parse.

| section | artifact | persona | organisation | predicates | records | routes |
|---|---|---|---|---|---:|---:|
| `routes` | `test-results/ui-audit.json` | the run's own owner | a fresh, empty organisation created for the run | T5, T6, R1, R2, R3, R4, R5, R6, R7 | 360 | 40 |
| `permissions` | `test-results/ui-audit-permissions.json` | the `member` persona, compared against the owner of the same org | a SECOND organisation, created by that spec and never touched by the primary run | T7 | 27 | 27 |
| `interaction` | `test-results/ui-audit-interaction.json` | the run's own owner, in the `audit-interaction` project — which ACTIVATES controls and never presses a confirm | a fresh, empty organisation created for the run | F8, F9, F10, R8 | 160 | 40 |
| `behaviour` | `test-results/ui-audit-behaviour.json` | the owner of an organisation the spec signs up itself | a THIRD organisation, on the default plan, seeded with two rows in every list `seedFilterFixtures` reaches | B1, B2, B3, B4, B5 | 200 | 40 |

**A cell no artifact carries is `NOT MEASURED`, never N/A and never a pass.** An N/A is a claim
about the page — RUBRIC.md's rule 2 requires it to be derivable from the route record — and
"the instrument did not reach this route" is a claim about the instrument. It gets its own column
below and is never folded into N/A; `score` stays `PASS ÷ (PASS + FAIL)`, so a withheld verdict
leaves the denominator and a predicate withheld everywhere scores `—`, never `1.00`.

| withheld | routes | why the instrument did not answer |
|---|---:|---|
| **B1** | 10 | answered-empty — the route's answered render is its empty state, and a server-backed empty answer and a client read that has not answered render the same |
| **B2** | 6 | hosted-only — the hosted product renders this page differently (an upsell on a plan without the feature, or the billing and usage panels the self-managed notice replaces), and the release gate's self-managed console never shows it; the skeleton question needs a leg booted as the hosted edition |
| **B3** | 4 | answered-empty — the route's answered render is its empty state, and a server-backed empty answer and a client read that has not answered render the same |
| **B3** | 18 | no-page-reads — every read this route made is its shell's (or it made none), so no failure or wait of its own can be injected from the browser |
| **B4** | 3 | answered-empty — the route's answered render is its empty state, and a server-backed empty answer and a client read that has not answered render the same |
| **B4** | 7 | no-page-reads — every read this route made is its shell's (or it made none), so no failure or wait of its own can be injected from the browser |
| **B4** | 1 | no-reads-failed — the route made no data read, so forcing reads to fail reached nothing |
| **B5** | 8 | no-page-reads — every read this route made is its shell's (or it made none), so no failure or wait of its own can be injected from the browser |
| **B5** | 10 | not-intercepted — none of the route's reads was made again on the failure loads, so nothing was failed |
| **B5** | 1 | over-read-budget — the route makes 12 reads of its own and B5 fails at most 8 one at a time |
| **T7** | 13 | the `permissions` run did not reach this route — it covers only the org-only routes; the parameterised ones need a project the persona cannot be given |

**Nothing is suppressed.** R5, R6 and R7 declare no N/A reason at all, so an N/A on one of them
is a parse error rather than a verdict. What still fails is recorded debt with an owner, and the
generator checks that ledger in both directions — a row that stops being true fails the build as
loudly as a missing one:

| predicate | FAIL | owner | what is failing |
|---|---:|---|---|
| **T5** | 2 | #6119 | `[project]/architecture` (and `[project]`, which redirects there): the empty canvas renders "Nothing designed yet" through `data-slot=empty-title` with no `@repo/ui/empty` region around it, so T5 reads a hand-rolled empty region. Appeared with the canvas lane's GET reads (#6213). |

**Family B is held per ROUTE** (`BEHAVIOUR_LEDGER`), because every page lane fixes B1–B5 on its own
routes and a per-predicate row could never shrink one lane at a time. A row is either `lifts` — measured
debt the named issue removes — or `reason` — a decision that the route is built this way. Checked in both
directions, like the table above:

| route | predicate | ledger | what fails |
|---|---|---|---|
| `/[org]` | **B1** | lifts #6118 | with every read held, the region differs from its answered render in: skeleton, content |
| `/[org]` | **B2** | lifts #6118 | the skeleton sets 3 blocks side by side and the page 2 |
| `/[org]/[project]/architecture` | **B1** | lifts #6119 | with every read held, the region differs from its answered render in: skeleton, content |
| `/[org]/[project]/clusters` | **B2** | lifts #6122 | the skeleton sets 2 blocks side by side and the page draws none |
| `/[org]/[project]/environments` | **B1** | lifts #6120 | with every read held, the region differs from its answered render in: content |
| `/[org]/[project]/environments` | **B4** | lifts #6120 | cold load: content vanished with no error surface; stale refetch: content vanished with no error surface |
| `/[org]/[project]/jobs` | **B2** | lifts #6121 | the skeleton moves 0.020 against the page (budget 0.02) — a 630px skeleton block became 632px, 46px lower |
| `/[org]/[project]/settings/access` | **B2** | lifts #6128 | the skeleton moves 0.033 against the page (budget 0.02) — a 160px skeleton block became 319px |
| `/[org]/[project]/settings/activity` | **B1** | lifts #6128 | with every read held, the region differs from its answered render in: skeleton, rows, content |
| `/[org]/[project]/settings/general` | **B1** | lifts #6128 | with every read held, the region differs from its answered render in: content |
| `/[org]/[project]/settings/general` | **B4** | lifts #6128 | cold load: content vanished with no error surface; stale refetch: content vanished with no error surface |
| `/[org]/[project]/usage` | **B4** | lifts #6127 | cold load: content vanished with no error surface; stale refetch: content vanished with no error surface |
| `/[org]/~/clusters` | **B2** | lifts #6122 | the skeleton sets 2 blocks side by side and the page draws none |
| `/[org]/~/connectors` | **B1** | lifts #6124 | with every read held, the region differs from its answered render in: content |
| `/[org]/~/connectors` | **B2** | lifts #6124 | the skeleton sets 2 blocks side by side and the page 3 |
| `/[org]/~/connectors` | **B4** | lifts #6124 | cold load: content vanished with no error surface; stale refetch: content vanished with no error surface |
| `/[org]/~/evidence` | **B2** | lifts #6126 | the skeleton moves 0.032 against the page (budget 0.02) — a 160px skeleton block became 192px, 156px higher |
| `/[org]/~/jobs/[id]` | **B2** | lifts #6121 | the skeleton moves 0.049 against the page (budget 0.02) — a 630px skeleton block became 707px, 96px higher |
| `/[org]/~/new` | **B2** | lifts #6131 | the skeleton moves 0.190 against the page (budget 0.02) — a 426px skeleton block became 797px; the skeleton draws no block-sized frame and the page 3 |
| `/[org]/~/runners` | **B1** | lifts #6123 | with every read held, the region differs from its answered render in: skeleton, empty copy, content |
| `/[org]/~/runners` | **B4** | lifts #6123 | stale refetch: endless skeleton |
| `/[org]/~/settings/activity` | **B1** | lifts #6129 | with every read held, the region differs from its answered render in: skeleton, rows, content |
| `/[org]/~/settings/billing/invoices` | **B2** | lifts #6127 | the skeleton moves 0.022 against the page (budget 0.02) — a 155px skeleton block became 132px, 122px higher |
| `/[org]/~/settings/classification` | **B1** | lifts #6129 | with every read held, the region differs from its answered render in: content |
| `/[org]/~/settings/classification` | **B2** | lifts #6129 | the skeleton moves 0.152 against the page (budget 0.02) — a 86px skeleton block became 532px; the skeleton sets 1 block side by side and the page 2 |
| `/[org]/~/settings/classification` | **B4** | lifts #6129 | cold load: content vanished with no error surface; stale refetch: content vanished with no error surface |
| `/[org]/~/settings/general` | **B1** | lifts #6128 | with every read held, the region differs from its answered render in: skeleton, content |
| `/[org]/~/settings/general` | **B2** | lifts #6128 | the skeleton moves 0.039 against the page (budget 0.02) — a 285px skeleton block became 515px, 7px lower |
| `/[org]/~/settings/general` | **B4** | lifts #6128 | cold load: endless skeleton, content vanished with no error surface; stale refetch: endless skeleton, content vanished with no error surface |
| `/[org]/~/settings/general` | **B5** | lifts #6128 | one read failing alone blanked every region — the `getOrgSettings (apps/console/app/server/actions/org-settings.ts)` server action |
| `/[org]/~/settings/roles` | **B2** | lifts #6129 | the skeleton moves 0.036 against the page (budget 0.02) — a 203px skeleton block became 80px, 53px lower; the skeleton sets 1 block side by side and the page 2 |
| `/[org]/~/settings/teams` | **B1** | lifts #6129 | with every read held, the region differs from its answered render in: skeleton, rows, content |
| `/[org]/~/settings/teams` | **B4** | lifts #6129 | cold load: empty copy, content vanished with no error surface; stale refetch: empty copy, content vanished with no error surface |
| `/[org]/~/support/abuse` | **B2** | lifts #6130 | the skeleton moves 0.115 against the page (budget 0.02) — a 494px skeleton block became 807px; the skeleton draws no block-sized frame and the page 1 |
| `/[org]/~/support/cases/[id]` | **B2** | lifts #6130 | the skeleton moves 0.035 against the page (budget 0.02) — a 64px skeleton block became 221px, 114px higher |
| `/[org]/~/support/my-cases` | **B2** | lifts #6130 | the skeleton moves 0.074 against the page (budget 0.02) — a 415px skeleton block became 139px |
| `/[org]/~/support/submit` | **B2** | lifts #6130 | the skeleton moves 0.020 against the page (budget 0.02) — a 420px skeleton block became 507px; the skeleton draws no block-sized frame and the page 2 |
| `/[org]/~/usage` | **B2** | lifts #6127 | the skeleton moves 0.066 against the page (budget 0.02) — a 82px skeleton block became 96px, 81px higher; the skeleton sets 2 blocks side by side and the page 1 |

## Per predicate

`score = PASS ÷ (PASS + FAIL)`. N/A leaves the denominator, so the N/A column is first-class:
a predicate whose N/A count grows is a predicate being escaped. `NOT MEASURED` leaves it too, and
has a column of its own for the same reason — it is a fact about the instrument, not about a page.

| id | family | instrument | PASS | FAIL | N/A | NOT MEASURED | score | N/A reasons |
|---|---|---|---:|---:|---:|---:|---:|---|
| **S1** | S | `check-route-states` | 36 | 0 | 4 | 0 | 1.00 | `redirect-only` 4 |
| **S2** | S | `check-route-states` | 35 | 1 | 4 | 0 | 0.97 | `redirect-only` 4 |
| **S3** | S | `check-route-states` | 36 | 0 | 4 | 0 | 1.00 | `redirect-only` 4 |
| **S4** | S | `check-route-states` | 36 | 0 | 4 | 0 | 1.00 | `redirect-only` 4 |
| **T1** | T | `check-route-states` | 36 | 0 | 4 | 0 | 1.00 | `redirect-only` 4 |
| **T2** | T | `check-route-states` | 40 | 0 | 0 | 0 | 1.00 | — |
| **T3** | T | `check-route-states` | 11 | 0 | 29 | 0 | 1.00 | `does-not-call-not-found` 29 |
| **T4** | T | `check-route-states` | 40 | 0 | 0 | 0 | 1.00 | — |
| **T5** | T | live — `routes` | 16 | 2 | 22 | 0 | 0.89 | `no-empty-state` 22 |
| **T6** | T | live — `routes` | 36 | 0 | 4 | 0 | 1.00 | `redirect-only` 4 |
| **T7** | T | live — `permissions` | 2 | 0 | 25 | 13 | 1.00 | `no-restricted-surface` 25 |
| **H1** | H | `check-shared-surface` | 40 | 0 | 0 | 0 | 1.00 | — |
| **H2** | H | `check-shared-surface` | 40 | 0 | 0 | 0 | 1.00 | — |
| **H3** | H | `check-shared-surface` | 40 | 0 | 0 | 0 | 1.00 | — |
| **H4** | H | `check-shared-surface` | 40 | 0 | 0 | 0 | 1.00 | — |
| **H5** | H | `check-shared-surface` | 40 | 0 | 0 | 0 | 1.00 | — |
| **H6** | H | `check-shared-surface` | 40 | 0 | 0 | 0 | 1.00 | — |
| **H7** | H | `check-shared-surface` | 40 | 0 | 0 | 0 | 1.00 | — |
| **H8** | H | `check-shared-surface` | 40 | 0 | 0 | 0 | 1.00 | — |
| **H9** | H | `check-shared-surface` | 40 | 0 | 0 | 0 | 1.00 | — |
| **F1** | F | `check-filter-standard` | 16 | 0 | 24 | 0 | 1.00 | `not-a-list-page` 24 |
| **F2** | F | `check-filter-standard` | 16 | 0 | 24 | 0 | 1.00 | `not-a-list-page` 24 |
| **F3** | F | `check-filter-standard` | 16 | 0 | 24 | 0 | 1.00 | `not-a-list-page` 24 |
| **F4** | F | `check-filter-standard` | 16 | 0 | 24 | 0 | 1.00 | `not-a-list-page` 24 |
| **F5** | F | `check-filter-standard` | 16 | 0 | 24 | 0 | 1.00 | `not-a-list-page` 24 |
| **F6** | F | `check-filter-standard` | 16 | 0 | 24 | 0 | 1.00 | `not-a-list-page` 24 |
| **F7** | F | `check-filter-standard` | 16 | 0 | 24 | 0 | 1.00 | `not-a-list-page` 24 |
| **F8** | F | live — `interaction` | 16 | 0 | 24 | 0 | 1.00 | `not-a-list-page` 24 |
| **F9** | F | live — `interaction` | 16 | 0 | 24 | 0 | 1.00 | `not-a-list-page` 24 |
| **F10** | F | live — `interaction` | 15 | 0 | 25 | 0 | 1.00 | `no-search-field` 1, `not-a-list-page` 24 |
| **R1** | R | live — `routes` | 36 | 0 | 4 | 0 | 1.00 | `redirect-only` 4 |
| **R2** | R | live — `routes` | 39 | 0 | 1 | 0 | 1.00 | `opens-no-overlay` 1 |
| **R3** | R | live — `routes` | 36 | 0 | 4 | 0 | 1.00 | `redirect-only` 4 |
| **R4** | R | live — `routes` | 36 | 0 | 4 | 0 | 1.00 | `redirect-only` 4 |
| **R5** | R | live — `routes` | 40 | 0 | 0 | 0 | 1.00 | — |
| **R6** | R | live — `routes` | 40 | 0 | 0 | 0 | 1.00 | — |
| **R7** | R | live — `routes` | 40 | 0 | 0 | 0 | 1.00 | — |
| **R8** | R | live — `interaction` | 34 | 0 | 6 | 0 | 1.00 | `no-enabled-controls` 2, `redirect-only` 4 |
| **B1** | B | live — `behaviour` | 15 | 11 | 4 | 10 | 0.58 | `redirect-only` 4 |
| **B2** | B | live — `behaviour` | 12 | 18 | 4 | 6 | 0.40 | `redirect-only` 4 |
| **B3** | B | live — `behaviour` | 14 | 0 | 4 | 22 | 1.00 | `redirect-only` 4 |
| **B4** | B | live — `behaviour` | 17 | 8 | 4 | 11 | 0.68 | `redirect-only` 4 |
| **B5** | B | live — `behaviour` | 16 | 1 | 4 | 19 | 0.94 | `redirect-only` 4 |
| **B6** | B | **none** — #6115 | — | — | — | — | — | — |

The static H half emits **no N/A at all**, which is why those rows are empty rather than
carrying the rubric's `renders-no-table` / `renders-no-formatted-value` / `declares-no-z-index`.
A matcher cannot tell "this page has no table" from "this page's table is correct" — both are
zero findings — so claiming the N/A would shrink the denominator on evidence that does not bear
on it. Every page is asked, and a page with no table passes H4 by not hand-rolling one.

## Per route

Each cell is `PASS/scored · score` over that family's instrumented predicates —
S 4/4, T 7/7, H 9/9, F 10/10, R 8/8, B 5/6.

**The size of each page's module closure is deliberately not in this file.** It is the set the H
column was measured over, but it is not a predicate and scores nothing, and it moves by one on
every route that reaches a module somebody adds — so checked in, it made every console PR stale
against every other one without a single score changing (#5296). It is computed on every run and
printed in the CI step summary of the in-sync check, where it conflicts with nothing.

A `· n withheld` suffix means n of that family's predicates were NOT MEASURED on this route: the
score is over the rest, and the cell says so rather than letting a narrower measurement read wider.

**The overall column carries its withheld count ALWAYS, including when it is zero.** A score is
not comparable to another score until you know how many predicates each one is an answer to, and
`0.97 · 4 withheld of 44` is a different claim from `0.97 · 0 withheld of 44` — the first is an
answer about 40 predicates wearing the shape of an answer about 44. The zero is printed rather than
implied by a missing suffix, because a suffix that is usually absent is read as decoration.

| route | S | T | H | F | R | B | overall |
|---|---|---|---|---|---|---|---|
| `/[org]/~/settings/general` | 4/4 · 1.00 | 4/4 · 1.00 | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 1/5 · 0.20 | **0.87** · 0 withheld of 44 |
| `/[org]/~/settings/classification` | 4/4 · 1.00 | 4/4 · 1.00 | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 2/5 · 0.40 | **0.90** · 0 withheld of 44 |
| `/[org]/~/connectors` | 4/4 · 1.00 | 4/4 · 1.00 | 9/9 · 1.00 | 10/10 · 1.00 | 8/8 · 1.00 | 0/3 · 0.00 · 2 withheld | **0.92** · 2 withheld of 44 |
| `/[org]` | 4/4 · 1.00 | 5/5 · 1.00 | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 0/2 · 0.00 · 3 withheld | **0.93** · 3 withheld of 44 |
| `/[org]/[project]/settings/general` | 4/4 · 1.00 | 5/5 · 1.00 · 1 withheld | 9/9 · 1.00 | all N/A | 7/7 · 1.00 | 3/5 · 0.60 | **0.93** · 1 withheld of 44 |
| `/[org]/~/jobs/[id]` | 3/4 · 0.75 | 6/6 · 1.00 · 1 withheld | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 2/3 · 0.67 · 2 withheld | **0.93** · 3 withheld of 44 |
| `/[org]/[project]/environments` | 4/4 · 1.00 | 5/5 · 1.00 · 1 withheld | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 3/5 · 0.60 | **0.94** · 1 withheld of 44 |
| `/[org]/[project]` · | all N/A | 2/3 · 0.67 · 1 withheld | 9/9 · 1.00 | all N/A | 4/4 · 1.00 | all N/A | **0.94** · 1 withheld of 44 |
| `/[org]/[project]/architecture` | 4/4 · 1.00 | 5/6 · 0.83 · 1 withheld | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 4/5 · 0.80 | **0.94** · 1 withheld of 44 |
| `/[org]/~/runners` | 4/4 · 1.00 | 5/5 · 1.00 | 9/9 · 1.00 | 10/10 · 1.00 | 8/8 · 1.00 | 0/2 · 0.00 · 3 withheld | **0.95** · 3 withheld of 44 |
| `/[org]/~/settings/teams` | 4/4 · 1.00 | 5/5 · 1.00 | 9/9 · 1.00 | 10/10 · 1.00 | 8/8 · 1.00 | 2/4 · 0.50 · 1 withheld | **0.95** · 1 withheld of 44 |
| `/[org]/~/support/abuse` | 4/4 · 1.00 | 4/4 · 1.00 | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 1/2 · 0.50 · 3 withheld | **0.96** · 3 withheld of 44 |
| `/[org]/~/support/submit` | 4/4 · 1.00 | 4/4 · 1.00 | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 1/2 · 0.50 · 3 withheld | **0.96** · 3 withheld of 44 |
| `/[org]/[project]/usage` | 4/4 · 1.00 | 6/6 · 1.00 · 1 withheld | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 0/1 · 0.00 · 4 withheld | **0.96** · 5 withheld of 44 |
| `/[org]/~/clusters` | 4/4 · 1.00 | 5/5 · 1.00 | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 1/2 · 0.50 · 3 withheld | **0.96** · 3 withheld of 44 |
| `/[org]/~/support/cases/[id]` | 4/4 · 1.00 | 5/5 · 1.00 · 1 withheld | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 1/2 · 0.50 · 3 withheld | **0.96** · 4 withheld of 44 |
| `/[org]/~/usage` | 4/4 · 1.00 | 4/4 · 1.00 | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 2/3 · 0.67 · 2 withheld | **0.96** · 2 withheld of 44 |
| `/[org]/[project]/clusters` | 4/4 · 1.00 | 6/6 · 1.00 · 1 withheld | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 1/2 · 0.50 · 3 withheld | **0.97** · 4 withheld of 44 |
| `/[org]/~/new` | 4/4 · 1.00 | 4/4 · 1.00 | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 4/5 · 0.80 | **0.97** · 0 withheld of 44 |
| `/[org]/~/settings/billing/invoices` | 4/4 · 1.00 | 4/4 · 1.00 | 9/9 · 1.00 | 9/9 · 1.00 | 8/8 · 1.00 | 2/3 · 0.67 · 2 withheld | **0.97** · 2 withheld of 44 |
| `/[org]/[project]/settings/access` | 4/4 · 1.00 | 6/6 · 1.00 · 1 withheld | 9/9 · 1.00 | 10/10 · 1.00 | 8/8 · 1.00 | 0/1 · 0.00 · 4 withheld | **0.97** · 5 withheld of 44 |
| `/[org]/~/evidence` | 4/4 · 1.00 | 5/5 · 1.00 | 9/9 · 1.00 | 10/10 · 1.00 | 8/8 · 1.00 | 1/2 · 0.50 · 3 withheld | **0.97** · 3 withheld of 44 |
| `/[org]/~/support/my-cases` | 4/4 · 1.00 | 5/5 · 1.00 | 9/9 · 1.00 | 10/10 · 1.00 | 8/8 · 1.00 | 2/3 · 0.67 · 2 withheld | **0.97** · 2 withheld of 44 |
| `/[org]/~/settings/activity` | 4/4 · 1.00 | 4/4 · 1.00 | 9/9 · 1.00 | 10/10 · 1.00 | 8/8 · 1.00 | 4/5 · 0.80 | **0.97** · 0 withheld of 44 |
| `/[org]/[project]/jobs` | 4/4 · 1.00 | 5/5 · 1.00 · 1 withheld | 9/9 · 1.00 | 10/10 · 1.00 | 8/8 · 1.00 | 4/5 · 0.80 | **0.98** · 1 withheld of 44 |
| `/[org]/~/settings/roles` | 4/4 · 1.00 | 5/5 · 1.00 | 9/9 · 1.00 | 10/10 · 1.00 | 8/8 · 1.00 | 4/5 · 0.80 | **0.98** · 0 withheld of 44 |
| `/[org]/[project]/settings/activity` | 4/4 · 1.00 | 6/6 · 1.00 · 1 withheld | 9/9 · 1.00 | 10/10 · 1.00 | 8/8 · 1.00 | 4/5 · 0.80 | **0.98** · 1 withheld of 44 |
| `/[org]/[project]/settings` · | all N/A | 2/2 · 1.00 · 1 withheld | 9/9 · 1.00 | all N/A | 4/4 · 1.00 | all N/A | **1.00** · 1 withheld of 44 |
| `/[org]/[project]/settings/preview` | 4/4 · 1.00 | 5/5 · 1.00 · 1 withheld | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 5/5 · 1.00 | **1.00** · 1 withheld of 44 |
| `/[org]/~/alerts` | 4/4 · 1.00 | 5/5 · 1.00 | 9/9 · 1.00 | 10/10 · 1.00 | 8/8 · 1.00 | all withheld (5) | **1.00** · 5 withheld of 44 |
| `/[org]/~/jobs` | 4/4 · 1.00 | 5/5 · 1.00 | 9/9 · 1.00 | 10/10 · 1.00 | 8/8 · 1.00 | 5/5 · 1.00 | **1.00** · 0 withheld of 44 |
| `/[org]/~/settings` · | all N/A | 2/2 · 1.00 | 9/9 · 1.00 | all N/A | 4/4 · 1.00 | all N/A | **1.00** · 0 withheld of 44 |
| `/[org]/~/settings/access` | 4/4 · 1.00 | 5/5 · 1.00 | 9/9 · 1.00 | 10/10 · 1.00 | 8/8 · 1.00 | 1/1 · 1.00 · 4 withheld | **1.00** · 4 withheld of 44 |
| `/[org]/~/settings/billing` | 4/4 · 1.00 | 4/4 · 1.00 | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 2/2 · 1.00 · 3 withheld | **1.00** · 3 withheld of 44 |
| `/[org]/~/settings/members` | 4/4 · 1.00 | 4/4 · 1.00 | 9/9 · 1.00 | 10/10 · 1.00 | 8/8 · 1.00 | 5/5 · 1.00 | **1.00** · 0 withheld of 44 |
| `/[org]/~/settings/sso` | 4/4 · 1.00 | 6/6 · 1.00 | 9/9 · 1.00 | 10/10 · 1.00 | 8/8 · 1.00 | 1/1 · 1.00 · 4 withheld | **1.00** · 4 withheld of 44 |
| `/[org]/~/support` | 4/4 · 1.00 | 4/4 · 1.00 | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 2/2 · 1.00 · 3 withheld | **1.00** · 3 withheld of 44 |
| `/[org]/~/support/ask` | 4/4 · 1.00 | 4/4 · 1.00 | 9/9 · 1.00 | all N/A | 8/8 · 1.00 | 2/2 · 1.00 · 3 withheld | **1.00** · 3 withheld of 44 |
| `/cli/login` | 4/4 · 1.00 | 4/4 · 1.00 | 9/9 · 1.00 | all N/A | 6/6 · 1.00 | 2/2 · 1.00 · 3 withheld | **1.00** · 3 withheld of 44 |
| `/dashboard/[[...rest]]` · | all N/A | 3/3 · 1.00 | 9/9 · 1.00 | all N/A | 4/4 · 1.00 | all N/A | **1.00** · 0 withheld of 44 |

`·` marks a redirect-only route: no JSX, a `redirect()` call. It is N/A for six of the eight
route-state predicates and passes the H rows on a closure of one file that renders nothing. It is
**not** N/A for R5, R6 and R7: hitting one of those URLs is a navigation a person really makes, so
the console errors it produces and the time it takes to land are real and are measured.

## Where every shared-surface occurrence landed

`check-shared-surface` found **22 occurrences across 14 files**. This section
accounts for all of them twice — once by ledger, once by reach — so a rule or a file falling out
of the scoreboard cannot be quiet.

| rule | predicate | total | recorded decision | measured drift | unlisted | in a page's surface | shared chrome only | shared package | outside the private tree |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `data_table` | H4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `empty_state` | H9 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `format` | H5 | 4 | 4 | 0 | 0 | 1 | 3 | 0 | 0 |
| `ink_alpha` | **none** — #4309 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `layer_token` | H7 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `page_title` | H1 | 17 | 17 | 0 | 0 | 6 | 1 | 0 | 10 |
| `section_header` | H2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `stat_strip` | H6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `status_badge` | H3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `type_scale` | H8 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| **total** | | 22 | 22 | 0 | 0 | 7 | 4 | 0 | 11 |

**`unlisted` is the column to read first.** A non-zero value means the guard is red — an
occurrence neither a `reason:` nor a `lifts:` entry accounts for. It is not a defect of this
report; run `pnpm check:shared-surface`.

**Matchers that map to no rubric predicate**, each with the issue that owns it. A rule here is
not unscored by accident — it measures something the rubric has no row for, or measures a row's
subject in a way that is not that row's verdict.

| rule | owner | why it maps to nothing |
| --- | --- | --- |
| `ink_alpha` | #4309 | a static, preventive guard for the contrast R5 measures live — a class-string finding is not a rendered verdict, and scoring one predicate with both would make a route's R5 depend on whether its dead code was linted |

**Reachable only from the shared layout chain** — 3 files. These are real
occurrences in the sidebar, topbar, breadcrumbs and shells that every route renders. They are not
in any route's H column, because attributing the chrome's drift to all 40 routes would say the
console is 40 times worse than it is. The full list is in `ui-conformance-baseline.json`.

**In a shared package, where no console closure can see them** — 0 files. These live
outside `apps/console` and are reached through a bare `@repo/*` specifier, which the module closure
deliberately does not follow. **They are not unimported, and nothing here claims they are** — most
of them are primitives that many console pages render through. What is true is narrower: the
closure cannot say WHICH routes reach them, so they are counted here rather than attributed to a
route's H column or filed under the table below, whose whole claim is that no page imports the
file. Fixing one of these is worth more than its occurrence count suggests, not less:

_None — every occurrence in this bucket has been lifted._

**Outside every private route's module graph** — 5 files, all under `apps/console`.
Public routes (sign-in, onboarding, OAuth consent, accepting terms) and console modules no private
page imports. The route manifest is scoped to `app/(private)`, so these are outside the rubric's
stated subject and are listed here rather than scored. A file reached only through `@repo/*` is
**not** in this table — see the shared-package section above:

| file | occurrences |
|---|---:|
| `apps/console/components/auth/auth-form.tsx` | 5 |
| `apps/console/components/auth/onboarding-form.tsx` | 2 |
| `apps/console/components/forms/oauth-consent-form.tsx` | 2 |
| `apps/console/components/errors/error-state.tsx` | 1 |
| `apps/console/components/legal/accept-terms-form.tsx` | 1 |

_Generated by `apps/console/scripts/audit-report.mjs`. Do not edit below the marker — run `pnpm -C apps/console run audit:report --write`._

<!-- END GENERATED: audit-report -->
