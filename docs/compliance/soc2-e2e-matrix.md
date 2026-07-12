<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# SOC 2 end-to-end control matrix

This document maps Alethia's automated tests to the SOC 2 Trust Services Criteria (TSC)
they give assurance over, and to the evidence each produces.

> [!IMPORTANT]
> **These tests are engineering *regression protection*, not the audit artifact.**
> Passing CI proves the control *logic still behaves as designed on every commit*. The
> SOC 2 **audit artifact** is the operational evidence produced over the audit window:
> the **ed25519-signed elench evidence receipts** (`packages/core/verify/receipt.go`) and the
> **immutable `audit_log`** (`apps/console/lib/db/schema/project-components.ts`). A green
> test suite is a *design-effectiveness* signal; the receipt ledger + audit log are the
> *operating-effectiveness* record an auditor samples. **Do not conflate the two** — a
> control can be correctly implemented (tests green) and still lack operating evidence for
> a given period, and vice versa.

## How to read the table

- **Control (TSC)** — the Trust Services Criterion the row supports.
- **What proves it (test)** — the regression test(s) that pin the behaviour in CI.
- **Evidence (audit artifact)** — the durable, sampleable record produced in production.

## CC6 — Logical & physical access controls

| Control (TSC) | What proves it (regression test) | Evidence (audit artifact) |
| --- | --- | --- |
| CC6.1 Logical access is restricted to authorized users | `apps/console/tests/lib/authz/authz.test.ts`, `apps/console/tests/integration/postgres-rbac-pdp.test.ts` (OpenFGA PDP decisions), `apps/console/tests/integration/authz-seed.test.ts` | OpenFGA tuple store + `audit_log` rows for privileged actions |
| CC6.1 Keyless / least-privilege cloud access (no long-lived secrets) | **elench corpus** `KEYLESS-001`, `GCP-KEYLESS-001`, `AZURE-KEYLESS-001`; `OIDC-001`, `GCP-WIF-001`, `AZURE-FED-001` (federation is subject-bound) — `packages/core/verify/testdata/corpus/` + `corpus_test.go` + `mutate_test.go` | Signed `verify.Report` receipt per plan (keyless/OIDC-sub controls, `PlanSHA256`-bound) |
| CC6.3 Access is granted on least privilege | `LEASTPRIV-001`, `GCP-LEASTPRIV-001`, `AZURE-LEASTPRIV-001` (corpus + mutation gate); `ACCESS-ANALYZER-001` (`options_test.go`) | Signed receipt findings; `audit_log` of role/policy changes |
| CC6.7 Data is protected in transit/at rest; secrets are not exposed | `apps/runner/internal/agent/output_scrub_test.go` (runner log/secret scrubbing) | Scrubbed job logs; storage-side encryption config |
| CC6.x Tenant isolation (row-level security) | `apps/console/tests/integration/rls.test.ts`, `apps/console/tests/integration/support-rls.test.ts` | Postgres RLS policies (`lib/db/programmables.sql`); `audit_log` |

## CC7 — System operations (monitoring & anomaly detection)

| Control (TSC) | What proves it (regression test) | Evidence (audit artifact) |
| --- | --- | --- |
| CC7.1 Detect configuration that violates policy before it takes effect | **elench compliance corpus** — 19 labeled OpenTofu plans scored with **0 false-PASS** (`packages/core/verify/corpus_test.go`); the **mutation gate** (`mutate_test.go`) proves each control discriminates | Signed `verify.Report` receipts (PLAN + DEPLOY) attached to each job's `execution_metadata["verify_result"]` |
| CC7.1 Detect drift from the approved baseline (keep proving it) | `packages/core/drift/drift_test.go` (turns `plan -refresh-only -json` into a `Posture`) | Per-environment drift `Posture` records |
| CC7.2 Anomalies are identified and evaluated | corpus `not_evaluable` plans — the gate never silently passes an un-inspectable plan (`aws/gcp/azure_not_evaluable_*.json`) | `not_evaluable` controls with coverage notes in the receipt |

## CC8 — Change management

| Control (TSC) | What proves it (regression test) | Evidence (audit artifact) |
| --- | --- | --- |
| CC8.1 Changes are authorized, tested, and approved before deployment | The **plan → verify → apply gate**: `RunDeployV2` runs `verify.Evaluate` between `tofu plan` and `tofu apply`, **fail-closed** (a hard control failure blocks apply unless an authorized `verify.Override` waives it). Pinned by `verify_test.go` (`TestStaticKeyBlocks`, `Blocking()`), `override_test.go`, and `apps/runner/internal/agent/verify_override_test.go` | Signed receipt with any `RecordedException` (who waived what, and why) + `audit_log` |
| CC8.1 The gate cannot be silently weakened | The **anti-vacuity guards**: `scripts/check-go-test-imports.mjs` (Go tripwire) + `TestCorpusControlCoverage` (every control has a fail-labeled plan) + the mutation gate (every control flips) | CI `guards` job history |

## Encryption / confidentiality

| Control (TSC) | What proves it (regression test) | Evidence (audit artifact) |
| --- | --- | --- |
| Secrets are never emitted to logs/state | `apps/runner/internal/agent/output_scrub_test.go`; state is proxied through the console, not handed to the runner | Scrubbed logs; tofu-state proxy access records |
| Evidence is tamper-evident | `packages/core/verify/receipt_test.go` — signed-receipt round-trip **and tamper detection** (a mutated receipt fails verification) | ed25519-signed receipts; optional Rekor transparency-log entry |

## The anti-vacuity spine (why this matrix is trustworthy)

A control matrix is worthless if the tests behind it are golden theater (a fixture matching
an expectation, asserting nothing real). Three mechanisms defend against that:

1. **Labeled corpus + false-PASS gate** (`corpus_test.go`) — 19 real OpenTofu plan JSONs with a
   `labels.json` ground truth; a plan labeled `fail` that the gate does **not** block fails CI
   hard (a false-PASS is a security hole). A false-DENY is reported but non-fatal.
2. **Mutation gate** (`mutate_test.go`) — takes a plan the gate scores `pass`, injects **one**
   control's violation, and asserts the verdict **flips to fail**. This proves the control
   *discriminates*, not that two hand-authored artifacts agree. One mutator per control.
3. **Vacuity tripwires** — `scripts/check-test-imports.mjs` (TypeScript) and
   `scripts/check-go-test-imports.mjs` (Go: `packages/core/verify` + `apps/runner`) fail CI on a
   test that can never fail; `TestCorpusControlCoverage` fails if any declared control ships with
   no fail-labeled corpus plan.

## Follow-up (not built here)

The corpus exercises the `verify` **engine** directly (`Evaluate` over plan JSON). Routing bad
plans through the **real runner pipeline** end-to-end (`tofu plan → verify → apply` in a live
runner, asserting the apply is actually blocked) depends on the **T0 provisioning harness** being
developed on a parallel branch. When that lands, add an integration test that feeds each corpus
`fail` plan through the runner and asserts the apply never executes — closing the gap between
"the engine says block" and "the pipeline actually blocked".
