<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Production QA runs

One file per witnessed pass over the **production** console, written by
`.claude/skills/console-prod-qa/SKILL.md`. This is layer 3 of the release gate — the only layer
with no simulation in it, and the only one that measures the production *configuration* rather
than a build.

It is not a test suite and nothing here is generated. Each file is a record of one run, by one
person, at one moment, against one named build. That is what makes it comparable to the next one
and what makes it citable; it is also why a run with no build id in its header is not a run.

## The index

Newest first. Each entry is `<file> — <build id> — <PASS/FAIL/NOT MEASURED counts>`.

_No production run has been taken yet._ **#4287** is the unit that takes the first one; the skill
is `disable-model-invocation: true`, so it happens when the maintainer names it, never because a
session decided a QA pass was due.

## The report schema

A run writes `apps/console/docs/qa/prod-runs/<date>-<time>.md`, and mints a run id
`qa-<yyyymmdd>-<hhmm>` in UTC that every resource it creates is named after
(`qa-<run-id>-…`), so a leftover is identifiable months later by anyone. The headings are fixed,
and in this order:

| # | heading | what it holds |
|---|---|---|
| 1 | **Header** | run id, the build version read from `window.__ENV.NEXT_PUBLIC_APP_VERSION`, UTC start and end, and the identity **as SHA-256 hashes only** |
| 2 | **Verdict counts** | PASS / FAIL / NOT MEASURED, per phase |
| 3 | **Routes** | the sweep over `scripts/lib/console-routes.mjs`, per route |
| 4 | **Journeys** | create → author → environment → connectors → alerts → classification → roles → teams → invite → support → billing dialogs → the filter surfaces |
| 5 | **Destructive sweep** | driven from `apps/console/destructive-actions.yaml`, in registry order — never from the page |
| 6 | **Defects** | one entry per symptom, each with the issue number filed for it |
| 7 | **Leftovers** | empty is the expected value, and saying so is the point |
| 8 | **What this run could NOT measure** | each with a reason from the fixed vocabulary below |
| 9 | **Testability gaps** | a control the pass could not name or could not reach |

**The `NOT MEASURED` vocabulary is closed**, and a run may not invent a reason: `by design` ·
`param unbindable` · `plan-gated` · `forbidden by blast radius` · `blocked by an earlier failure` ·
`instrument refused`. A fixed vocabulary is what makes "we did not measure this" countable across
runs instead of a sentence each author phrases their own way.

**Two things a report never contains.** The QA account's email and organization slug, in any form
but a hash — this repository is public and those two strings are exactly what an attacker would
want (`.claude/skills/console-prod-qa/allowlist.yaml` holds the digests). And screenshots: they
stay in the scratchpad, because a directory of PNGs is neither reviewable nor diffable and would
grow the repo every run.

## What a report is not evidence of

- **Not a regression suite.** Nothing re-runs these. A defect stops being fixed the moment its
  issue is closed, not the moment a later report omits it.
- **Not a substitute for a red gate leg.** A failing `Release gate (…)` leg is cheaper to read
  and cheaper to fix than a production finding, and a run taken to route around one is a run
  measuring a build nobody validated.
- **Not the layout verdict.** The `audit` leg scores layout against
  `apps/console/docs/ui-conformance/RUBRIC.md` over every route, at four widths, in both themes.
  A witnessed pass is worse at that and says so.

`apps/console/docs/qa/README.md` places this among the QA documents; `findings.md` is the standing
findings ledger for the `qa` Playwright suite, which a production run appends to neither.
