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

- [`2026-11-16-1521.md`](2026-11-16-1521.md) — `703d40d9` — gap-filling pass on the same build: filter surfaces 9 PASS / 6 NOT MEASURED (plan-gated) · per-control activation sampled on 4 routes · 0 rows created
- [`2026-11-16-1417.md`](2026-11-16-1417.md) — `703d40d9` — routes 40 PASS (overflow and per-control NOT MEASURED) · journeys 6 PASS / 2 FAIL / 4 NOT MEASURED · destructive 7 PASS / 42 NOT MEASURED — the first run (#4287)

A **golden-path** run (`golden-path <cloud> --allow-jobs`) is indexed the same way, as
`<file> — <build id> — B2 <cloud> <pass/fail/not-measured> — <steps completed>/6`.

The skill is `disable-model-invocation: true`, so a run happens when the maintainer names it, never
because a session decided a QA pass was due.

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

## B2 evidence records — the golden-path runs

This directory holds two kinds of file, and the first line after the SPDX comment tells them apart.

- **A sweep report** (`full`, `routes`, `journeys`, `destructive`) has **no front matter**. It is
  prose plus verdicts, with the headings above, and nothing reads it as evidence for a beta predicate.
- **A golden-path record** (`golden-path <cloud> --allow-jobs`, SKILL.md §7) **starts with YAML front
  matter** and is the evidence for predicate **B2** of `docs/beta/README.md` on one cloud.
  `scripts/programme-rollup.mjs` reads every such file here, validates it against
  `docs/beta/evidence-schema.json`, and evaluates B2 from the newest record per cloud.

One golden-path run is **one cloud, one fresh account, one file**, named after the run id's minute
like every other run here. Four clouds are four runs and four files. The front matter is written by
`.claude/skills/console-prod-qa/b2-record.mjs write` and never by hand: the rollup's reader takes a
narrow YAML subset, and a record it cannot read is an integrity failure on whichever PR next touches
the programme, not on the PR that added the record. A record looks like this:

```markdown
<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

---
schemaVersion: 1
predicate: B2
cloud: hetzner
date: "2026-12-14T10:32:00Z"
buildSha: "703d40d946914ab0dafdb4ed643a2c2437fa7def"
verdict: pass
instrument: .claude/skills/console-prod-qa/SKILL.md
observer: maintainer
freshAccount: true
steps: [sign-up, connect, design, deploy, running-cluster, destroy]
evidence:
  - apps/console/docs/qa/prod-runs/2026-12-14-1032.md
---

# B2 golden path — hetzner — qa-20261214-1032
```

The values are illustrative; they do not describe a real run. On top of the schema, the writer holds
the record to the skill's own rules: `date` is the run id's minute and the file name is the same
minute; `steps` are the completed steps in golden-path order, with no gap; `evidence` names the record
itself; and the file contains no email address. `node .claude/skills/console-prod-qa/b2-record.mjs
check` runs those rules over every record here, and `--self-test` proves the records it writes are
ones the rollup's own `deriveBeta` accepts.

**A record is never edited to change its verdict.** A new observation is a new file, and the newest by
`date` decides. A `fail` stays in the tree after a later `pass`: it is the history of what broke.

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
