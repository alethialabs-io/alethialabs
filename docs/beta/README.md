<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# The beta definition: predicates B1–B9

"Beta reached" means all nine predicates below are true at the same moment, on the same commit. This
file defines each one: what is measured, which instrument measures it, and what counts as a pass. It
also defines the evidence record that some predicates read, and where each record lives.

The public beta is planned for 2027-01-31. On that day all nine must be true.

This definition replaces the six predicates in §0 of `PROGRAMME.md` and the MVP definition in the
management repository's roadmap. Those still read five clouds and a CLI-first order. Changing them, and
teaching `pnpm check:programme` to evaluate B1–B9, is board unit REL-L1. Until REL-L1 lands, nothing
evaluates these predicates automatically. This file is the definition the evaluator is built against.

Source: the release-and-billing spec for the 2027-01-31 beta (§4.2 and §5 S1), as amended by the
maintainer decisions of 2026-11-17. Both live in the management repository. Where they differ, the
decisions win; the two places they change a predicate (B3 and B5) are marked below.

## How a predicate is evaluated

A predicate is evaluated at an **instant** *T* (UTC) against a **commit** *C*, normally the head of
`main`. Every age limit below is measured back from *T*. "On `main`" means
`git merge-base --is-ancestor <sha> origin/main` exits 0.

A predicate is true only when its instrument returns a pass. A `fail`, a `not-measured`, a missing
record and an instrument that cannot run all make it false. Nothing is assumed from silence.

Some predicates read an artefact that already exists in the tree or in CI. Others read an **evidence
record**: a Markdown file written by a person or a skill at the moment of an observation. The table
says which.

| # | Predicate | Reads | Per cloud |
|---|---|---|---|
| B1 | Exactly four clouds are offered | the offered set | no |
| B2 | Golden path observed on production | evidence records | yes |
| B3 | Same path from the CLI and through an outside agent | proof bundles and evidence records | yes |
| B4 | A full-bar real-apply proof | proof bundles | yes |
| B5 | Paid plans are open, with live evidence | the launch state and an evidence record | no |
| B6 | Legal set published at sealed versions, including beta terms | the legal-document register | no |
| B7 | Operations: backup, restore drill, public hosts | backup listing, an evidence record, the smoke report | no |
| B8 | Editions meet their own predicates | evidence records | no |
| B9 | Nothing left standing; nightly green | CI run history | yes |

"Per cloud" means the predicate is true only when it holds for each of the four offered clouds: `aws`,
`gcp`, `azure` and `hetzner`.

## The predicates

### B1 — exactly four clouds are offered

- **Measured:** the set of clouds the product offers.
- **Instrument:** the offered set from the capability switch. In Go that is
  `Catalog.OfferedProviders()` in `packages/core/catalog/catalog.go`. In TypeScript it is the generated
  catalog in `packages/cloud-catalog/src/generated.ts`, produced from the same source.
- **Pass:** the offered set on commit *C* is exactly `{aws, gcp, azure, hetzner}`. A fifth cloud, a
  missing cloud, or the Go and TypeScript sets disagreeing is a fail.

### B2 — the golden path, observed on production

- **Measured:** one person, starting from a new account on production, signs up, connects a cloud
  account, designs a project, deploys it, sees the cluster running, and destroys it.
- **Instrument:** a production QA run with jobs allowed, by `.claude/skills/console-prod-qa/SKILL.md`.
  Teaching the skill to write this record format is board unit REL-L13.
- **Evidence:** one record per cloud, in `apps/console/docs/qa/prod-runs/`, with `predicate: B2`.
- **Pass**, for each of the four clouds, from the newest B2 record for that cloud:
  - `verdict: pass`, `freshAccount: true`, and `steps` lists all six steps;
  - `date` is no more than 31 days before *T*;
  - `buildSha` is on `main`.

The B2 run is also where the managed-runner records of board unit REL-L18 are taken. Those carry
`predicate: B2`, `aspect: managed-runner`, and live in their own directory (see
[Where records live](#where-records-live)). They support B2 but do not decide it.

### B3 — the same path from the CLI, and through an outside agent

- **Measured:** the B2 path completes in two more ways, per cloud: driven by the `alethia` CLI, and
  driven by an outside agent whose deploy a human approved.
- **Instrument, CLI half:** the `cli-demo` dimension of `.github/workflows/e2e-nightly.yml`, which
  writes a proof bundle under `demos/proofs/<cloud>/<stamp>/`. The bar it holds is described in
  `docs/testing/cli-demo-bar.md`.
- **Instrument, agent half:** an agent-path run, recorded by hand or by the agent-surface wave's
  evaluation, as an evidence record with `predicate: B3` and `path: agent`.
- **Pass**, for each of the four clouds:
  - **CLI:** a bundle whose `provision-summary.json` has `dimension` equal to `cli-demo` and
    `outcome` equal to `success`, which `demos/proofs/check-proof-integrity.sh` accepts.
  - **Agent:** the newest agent-path record for that cloud has `verdict: pass` and names who approved
    (`approvedBy`).
  - **Changed by decision M35 (2026-11-17):** the agent path is real on Hetzner and stubbed on the other
    three clouds, and is stated as such. So a passing Hetzner agent record must have
    `substrate: real`. For `aws`, `gcp` and `azure`, `substrate: stub` is accepted, and the status
    output must print it next to the verdict.

The spec sets no age limit for B3. This file does not add one. If one is wanted, it is a decision for
the maintainer, not for the evaluator.

### B4 — a full-bar real-apply proof per cloud

- **Measured:** the full bar: maximum configuration plus every add-on, applied to a real cloud
  account and converged.
- **Instrument:** a dispatch of `.github/workflows/e2e-nightly.yml` with `full_bar: true`, which
  resolves to the `full` dimension (`scripts/e2e/resolve-dimension.sh`) and writes a proof bundle under
  `demos/proofs/<cloud>/<stamp>/`. The full bar has no cron; a dispatch is the only way to run it.
- **Pass**, for each of the four clouds: at least one bundle where
  - `provision-summary.json` has `dimension` equal to `full` and `outcome` equal to `success`;
  - `demos/proofs/check-proof-integrity.sh` accepts it;
  - `captured_at` is no more than 31 days before *T*.

A bundle with no `dimension` (older captures record `null`) does not count. Nothing infers a full bar
from a directory name or a log line.

### B5 — paid plans are open, with live evidence

- **Measured:** whether a customer can pay, and whether a real payment cycle has been seen working.
- **Instrument:** `paidLaunchState()` in `packages/legal/src/launch.ts`, evaluated on commit *C*; and
  one evidence record with `predicate: B5`.
- **Pass:**
  - `paidLaunchState().paid.status` is `open`; and
  - the newest B5 record has `verdict: pass` and `events` lists `purchase`, `failed-renewal`, `cancel`,
    `refund` and `tax-invoice`. These were observed on live Stripe, on production. The tax invoice is
    the "correct tax invoice" of the release-candidate exit test.
- **Changed by decision M15 (2026-11-17):** a paid no-go moves the launch. The spec's table allowed
  `announced` with a date as a pass. It no longer does. `announced` and `closed` both make B5 false.

The trial needs no separate check. `paidLaunchState()` returns the same value for `trial` as for `paid`,
cell by cell, and its tests hold it to that.

### B6 — the legal set is published at sealed versions, including beta terms

- **Measured:** every public legal document is published at a version whose text is fixed by a hash,
  and the Terms include the beta and no-SLA wording.
- **Instrument:** `LEGAL_DOCUMENTS` in `packages/legal/src/documents.ts`, checked by
  `pnpm check:legal-hashes`; and the register `docs/legal/legal-set.json`, checked by
  `pnpm check:legal-set`.
- **Pass:**
  - both checks exit 0 on commit *C*;
  - every entry in `LEGAL_DOCUMENTS` has a `contentHash` that matches its `source`;
  - the `terms` entry is at a version sealed with the beta and no-SLA wording. Writing that text is
    board unit LEG-L2. Until LEG-L2 merges, B6 is false.

### B7 — operations

B7 has three parts. All three must pass.

- **Off-box backup**
  - **Measured:** the age of the newest backup copy held at a second provider: a logical Postgres dump
    and a copy of the tofu-state bucket.
  - **Instrument:** the backup job and its listing, built by board unit REL-L7.
  - **Pass:** the newest complete copy is less than 26 hours older than *T*.
- **Restore drill**
  - **Measured:** a restore of that backup onto a throwaway box, timed, with erasure tombstones
    replayed before the restored console serves.
  - **Instrument:** the restore script from REL-L7, written up as an evidence record with
    `predicate: B7`, `check: restore-drill`.
  - **Pass:** the newest drill record has `verdict: pass`, `tombstonesReplayed: true`, a
    `durationSeconds`, and a `date` no more than 45 days before *T*.
- **Public hosts**
  - **Measured:** the status page and the public hosts answer, and the health check reads the response
    body, not only the status code.
  - **Instrument:** the "Post-deploy smoke" job in `.github/workflows/deploy-console.yml`. Board unit
    REL-L8 adds the CLI installer host and the status host to it. This file reads "both public hosts"
    in the spec as those two hosts; the console host is already in the smoke.
  - **Pass:** the newest production deploy's smoke passed every check, including the installer and
    status hosts, and it ran no more than 14 days before *T*. Fourteen days is how long the
    `post-deploy-smoke` artifact is kept. A deploy whose smoke ran but left no readable report does
    not pass. The snapshot holds a summary of the report: the check counts and the ids of failed
    checks.

### B8 — editions

- **Measured:** the hosted, enterprise and self-hosted editions each meet the predicates of the
  editions spec for the 2027-01-31 beta (management repository). This file does not restate them. A
  copy here would go stale, and nothing would report it.
- **Instrument:** one evidence record per edition, with `predicate: B8` and `edition` set, citing the
  editions spec's verification legs that produced it.
- **Pass:** for each of `hosted`, `enterprise` and `self-hosted`, the newest B8 record has
  `verdict: pass`, and its `evidence` points at the runs that the editions spec names.

### B9 — nothing left standing

B9 has two parts. Both must pass.

- **Orphan reaper clean**
  - **Measured:** cloud resources left behind by tests.
  - **Instrument:** the scheduled run of `.github/workflows/e2e-orphan-reaper.yml` (daily at 07:17
    UTC). A manual dispatch defaults to a dry run and does not count.
  - **Pass:** the newest scheduled run before *T* concluded `success`, and its summary reports nothing
    left standing on each of the four clouds.
- **Nightly green**
  - **Measured:** the scheduled floor nightly.
  - **Instrument:** the scheduled runs of `.github/workflows/e2e-nightly.yml` (daily at 03:17 UTC), with
    per-cloud verdicts derived by `scripts/e2e/nightly-rollup.sh`.
  - **Pass:** of the last 7 scheduled runs before *T*, at least 6 are green on all four clouds. A
    cancelled run counts as not green. A manual dispatch is not one of the 7.

## The evidence record

An evidence record is a Markdown file. It starts with YAML front matter and continues with prose that
says what was done, step by step. The front matter must validate against
[`evidence-schema.json`](evidence-schema.json) (JSON Schema, draft 2020-12).

One record is one observation: one predicate, one cloud (or `all`), one moment, one build and one
verdict. A record is never edited to change its verdict. A new observation is a new file. The newest
record by `date` decides, per predicate and cloud, and per `path`, `edition` or `check` where the
predicate has one.

### Fields every record has

| Field | Value |
|---|---|
| `schemaVersion` | `1` |
| `predicate` | `B1` to `B9` |
| `cloud` | `aws`, `gcp`, `azure`, `hetzner`, or `all`. B2, B3 and B4 name one cloud. B1, B5, B6, B7 and B8 use `all` |
| `date` | When the observation was made, in UTC, for example `2026-12-14T10:32:00Z` |
| `buildSha` | The full 40-character commit SHA of the build under test |
| `verdict` | `pass`, `fail` or `not-measured` |
| `instrument` | The repository path of the skill, script or workflow that made the observation, or `manual` |

A record with `verdict: pass` must also have `evidence`: a list of repository paths or `https` URLs where
the observation can be checked. `observer` (`agent`, `maintainer` or `cohort`) is optional.

### Fields that belong to one predicate

The schema refuses each of these on any other predicate.

| Predicate | Field | Value | Required on a pass |
|---|---|---|---|
| B2 | `freshAccount` | `true` when the run began from a new account | `true` |
| B2 | `steps` | from `sign-up`, `connect`, `design`, `deploy`, `running-cluster`, `destroy` | all six |
| B2 | `aspect` | `managed-runner` for a REL-L18 record; such a record skips the two fields above | — |
| B3 | `path` | `cli` or `agent` | always required |
| B3 | `substrate` | `real` or `stub` (agent path only, where it is required) | `real` on `hetzner` |
| B3 | `approvedBy` | `maintainer` or `cohort` (agent path only) | required on the agent path |
| B5 | `events` | from `purchase`, `failed-renewal`, `cancel`, `refund`, `tax-invoice` | all five |
| B7 | `check` | `restore-drill` | always required |
| B7 | `tombstonesReplayed` | `true` or `false` | `true` |
| B7 | `durationSeconds` | whole seconds from an empty box to a serving console | required |
| B8 | `edition` | `hosted`, `enterprise` or `self-hosted` | always required |

The cloud list in the schema is B1's offered set. If B1's set changes, the schema changes in the same
pull request.

### An example

```markdown
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
  - apps/console/docs/qa/prod-runs/README.md
---

# B2 golden path — hetzner — 2026-12-14

1. Signed up with a new address at 10:32 UTC. ...
```

The example values are illustrative. They do not describe a real run.

Quote `date` and `buildSha`. Some YAML parsers turn an unquoted timestamp into a date object, and a SHA
made only of digits into a number. The schema expects both as strings.

## Where records live

| Predicate | Records live in | File name |
|---|---|---|
| B2 | `apps/console/docs/qa/prod-runs/` | the QA run's own name, `<date>-<time>.md` |
| B2, `aspect: managed-runner` | `docs/beta/evidence/managed-runner/` | `<YYYY-MM-DD>-<cloud>.md` |
| B3, agent path | `docs/beta/evidence/b3/` | `<YYYY-MM-DD>-<cloud>-agent.md` |
| B5 | `docs/beta/evidence/b5/` | `<YYYY-MM-DD>-live-billing.md` |
| B7, restore drill | `docs/beta/evidence/b7/` | `<YYYY-MM-DD>-restore-drill.md` |
| B8 | `docs/beta/evidence/b8/` | `<YYYY-MM-DD>-<edition>.md` |

The `docs/beta/evidence/` directories do not exist yet. The first record in each creates it.

B1, B4, B6 and B9 take no record. Their instruments read artefacts that already exist: the catalog, the
proof bundles, the legal register and the CI run history. The CLI half of B3 reads proof bundles too. A
hand-written record for any of those would be a second copy of the truth.

## What this file does not do

- It does not evaluate anything. REL-L1 builds the evaluator and the four-cloud, nine-predicate status in
  `PROGRAMME.md`.
- No check in CI validates records against the schema yet. The first unit that writes records (REL-L13
  for B2) is expected to add one with them.
- It does not restate the editions predicates (B8), and it does not decide whether B3 has an age limit.
