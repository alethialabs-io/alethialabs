<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Security end-to-end control matrix

This document maps Alethia's **security** regression tests — the ones that pin the four
platform security invariants (tenant/authorization isolation, secret non-leakage,
sandbox-escape resistance, fail-closed gates) — to the SOC 2 Trust Services Criteria (TSC)
they give assurance over, and to the evidence each produces. It is the security-focused
sibling of [`soc2-e2e-matrix.md`](./soc2-e2e-matrix.md) and follows the same conventions.

> [!IMPORTANT]
> **These tests are engineering *regression protection*, not the audit artifact.**
> Passing CI proves each security control *still behaves as designed on every commit* — a
> *design-effectiveness* signal. The SOC 2 **audit artifact** is the operational evidence
> produced over the audit window: the ed25519-signed elench receipts
> (`packages/core/verify/receipt.go`), the immutable `audit_log`, the OpenFGA tuple store, and
> the Postgres RLS policies. A green suite and the durable evidence ledger are **not the same
> thing** — do not conflate them.
>
> Each test is built to be **non-vacuous**: it fails if the protection is removed. Two are
> proven so by construction (flipping the guard turns them red) — see the anti-vacuity spine.

## How to read the table

- **Control (TSC)** — the Trust Services Criterion the row supports.
- **What proves it (test)** — the security regression test(s) that pin the behaviour in CI.
- **Evidence (audit artifact)** — the durable, sampleable record produced in production.

## CC6 — Logical & physical access controls

| Control (TSC) | What proves it (regression test) | Evidence (audit artifact) |
| --- | --- | --- |
| CC6.1 Logical access is restricted to authorized users (and the two PDP engines AGREE) | `apps/console/tests/integration/pdp-parity.test.ts` — drives BOTH real engines (community `PostgresRbacPDP` over SQL **and** the OpenFGA-backed engine over a real store) against one fixture and asserts they return the same allow/deny on every case, cross-tenant included | OpenFGA tuple store + `audit_log`/`authz_activity_log` rows for privileged actions |
| CC6.x Tenant isolation — a tenant can neither READ nor WRITE another tenant's rows | `apps/console/tests/integration/rls.test.ts` — RLS `USING` (read) **and** `WITH CHECK` (write: cross-tenant INSERT rejected, cross-tenant UPDATE/DELETE affect 0 rows) across `projects` + `jobs`, with an own-scope control proving the wall isn't blocking everything | Postgres RLS policies (`lib/db/programmables.sql`, `owner_all`); `audit_log` |
| CC6.1 Cross-tenant reads are denied by BOTH the RBAC decision and the ReBAC store | `apps/console/tests/integration/pdp-parity.test.ts` (scoped grant does not reach another org's project; `listAccessible` never crosses the tenant boundary in either engine) | RLS policies + OpenFGA tuple store |
| CC6.6 Untrusted execution is isolated from platform credentials | `packages/core/sandbox/container_docker_test.go` — real-container canaries: parent runner secrets stripped from the child env + unreachable via `/proc/1` (separate PID namespace); no-egress stage cannot reach the cloud metadata service (IMDS) | Fleet default-deny egress net + domain-allowlist proxy; runner image config |
| CC6.7 Secrets are not exposed in persisted job records | `apps/runner/internal/agent/secret_nonleak_test.go` — a SENTINEL cluster credential planted in every credential-bearing tofu output never surfaces in the `execution_metadata` persisted to the console (drives the real `buildDeployMetadata` assembly); `apps/console/tests/api/jobs/status-route.test.ts` + `tests/lib/jobs/scrub-metadata.test.ts` — the console re-scrubs every runner post at ITS OWN trust boundary (a legacy/self-registered runner posting `argocd_admin_password` is dropped at ingest, before `update_job_status`) | Scrubbed `execution_metadata` on BOTH sides of the runner↔console boundary; storage-side encryption config |

## CC7 — System operations (monitoring & anomaly detection)

| Control (TSC) | What proves it (regression test) | Evidence (audit artifact) |
| --- | --- | --- |
| CC7.1 The sandbox hardening cannot silently regress | `packages/core/sandbox/container_security_test.go` — pure-Go (docker-free, always-on) assertions on the container argv: `--cap-drop ALL`, `--security-opt no-new-privileges`, `--network none` (no-egress), egress-filtered net (never `--network host`), read-only cred mounts, resource caps. Catches a dropped flag even on a PR CI runner without docker | Runner image + fleet network config |
| CC7.2 A mandated security canary is never silently skipped | `packages/core/sandbox/container_docker_test.go` — with `ALETHIA_SANDBOX_E2E=1` the docker canaries FAIL (not skip) if docker is absent, so a green security-CI run guarantees they actually executed | CI security-lane run history |

## CC8 — Change management

| Control (TSC) | What proves it (regression test) | Evidence (audit artifact) |
| --- | --- | --- |
| CC8.1 A change that violates policy is BLOCKED before it takes effect — and the gate fails CLOSED on ambiguity | `packages/core/iacsafety/iacsafety_security_test.go` — every evil/unresolvable BYO-IaC fixture is denied (`Report.OK == false`); crucially an **unresolvable** `source = var.src` is denied on AMBIGUITY (deny, not allow), with a `clean` control proving the gate can pass. `packages/core/verify/verify_security_test.go` — each hard-control-failure plan blocks the apply (`Blocking()`), a nil/uninspectable plan is `not_evaluable` (never a silent pass), and a clean plan clears | Signed `verify.Report` receipts (PLAN + DEPLOY) on `execution_metadata["verify_result"]`; runner gate logs |
| CC8.1 A blocked apply is only released by an AUTHORIZED, unexpired waiver | `packages/core/verify/verify_security_test.go` — `Unwaived` stays non-empty until an override that names the exact control AND has not expired waives it; an expired or unrelated override does not | Signed receipt `RecordedException` (who waived what, and why) + `audit_log` |
| CC8.1 A managed runner refuses to run untrusted work without confirmed isolation (fail-closed, not fail-open) | `packages/core/sandbox/container_security_test.go` — the managed passthrough refuses on any ambiguous/mis-cased/empty operator (only exact `self` is lenient); the container backend refuses a managed deploy without egress enforcement | Runner refusal in job logs; `ALETHIA_SANDBOX_ENFORCE_MANAGED` deploy config |

## Encryption / confidentiality

| Control (TSC) | What proves it (regression test) | Evidence (audit artifact) |
| --- | --- | --- |
| Cluster credentials are never emitted to the console record | `apps/runner/internal/agent/secret_nonleak_test.go` (full kubeconfigs / client keys scrubbed from `execution_metadata`); `apps/runner/internal/agent/output_scrub_test.go` (the scrub function itself) | Scrubbed `execution_metadata`; tofu-state proxy access records |
| State-backend secrets never touch a workdir file | `packages/core/cloud/http_backend_test.go` (`backend.hcl` carries no state token / cloud keys; the token rides `TF_HTTP_PASSWORD` env only) | tofu-state proxy; `backend.hcl` written by the pipeline |

## The anti-vacuity spine (why this matrix is trustworthy)

A security matrix is worthless if the tests behind it are golden theater. Each row is built to
FAIL when the protection is removed; two were proven so by flipping the guard:

1. **Secret non-leakage** (`secret_nonleak_test.go`) — replacing the scrub with the raw outputs
   (`metadata["outputs"] = result.Outputs`) makes the planted SENTINEL surface in the persisted
   metadata → the test goes **red**. Restored → green.
2. **Fail-closed IaC gate** (`iacsafety_security_test.go`) — downgrading the provisioner-block
   rule from error to warning flips the `provisioner` fixture to `OK=true` → the "was ALLOWED"
   assertion fires **red**. Restored → green.
3. **Both PDP engines are exercised for real** (`pdp-parity.test.ts`) — the decisions come from
   the real `PostgresRbacPDP` (SQL) and a **real OpenFGA store** performing ReBAC evaluation
   (not two mocks); a divergence between them fails the test with an explicit message.
4. **Discriminating controls, not deny-everything** — every fail-closed suite carries a `clean`
   / `pass` control fixture, and the RLS suite an own-scope control, so a gate that simply
   denied everything would make the green run meaningless — and would itself fail.
5. **Assert-not-skip** — the docker sandbox canaries fail (not skip) under `ALETHIA_SANDBOX_E2E=1`
   if docker is missing, so the security lane cannot pass without actually running them.

## Follow-up (not built here)

- **PDP engine divergence on org-wide-allow + same-action instance-deny — CLOSED.** The parity
  suite now combines an *org-wide ALLOW* with a *per-instance DENY of the same action* (PROJ_A3 in
  `pdp-parity.test.ts`) and asserts **both engines DENY** it (deny-wins). Root cause: the OpenFGA
  engine's `can()` ORed `checksFor` — whose org-wide `<type>_<action>` capability is the RAW org
  grant, not deny-aware — so the org allow overrode the instance deny. Fix: `OpenFgaPdp.can`
  (`ee/src/openfga-pdp.ts`) is now **explicit-deny-wins** — it evaluates `denyChecksFor`
  (`lib/authz/fga-mapping.ts`) alongside `checksFor` and VETOES on any deny before honouring the
  allow, exactly like `PostgresRbacPDP.decide`. `denyChecksFor` reuses the model's existing
  `deny_<action>` (instance, per-instance OR inherited) and `<type>_deny_<action>` (org-wide
  fallback) relations — no model or tuple-sync change (deny tuples were already expanded by
  `expandGrant`). The **sibling read-path, `OpenFgaPdp.listAccessible`, is fixed in the same PR**:
  its org-wide branch previously returned every org instance via `listOrgResourceIds` with NO deny
  subtraction (the same deny-blind bug class as `can()`), so an "allow the org except this project"
  or an org-wide deny was silently ignored when *enumerating* accessible ids. It now returns `[]` on
  an org-wide deny and subtracts per-instance denies (`listObjects deny_<action>`), matching
  `PostgresRbacPDP.listAccessible`; `pdp-parity.test.ts` asserts this on the org-wide `deploy` path
  (PROJ_A3 excluded). So "allow the org except this one project" now behaves identically on both
  tiers across **decide (`can`/`enforce`/`bulkCheck`) AND enumerate (`listAccessible`)**.
- **PDP engine divergence on a row whose `resource_type` cannot carry a `resource_id` — ALLOW side
  CLOSED, DENY side an OPEN RULING (#4584).** The same shape as the entry above — one row, two
  engines, opposite answers — found on a *different* column. `PostgresRbacPDP` did not project
  `resource_type` at all, so ANY non-null `resource_id` read as scoped to that id, while
  `expandGrant` computed `orgWide = resourceId === null || resourceType === "org"` and dropped the
  id. An `('org', <project-uuid>)` row was therefore NARROW on the community tier and
  ORGANIZATION-WIDE on the paid one, from identical data, with which engine you run decided by an
  instance-wide env switch (`OPENFGA_API_URL`/`OPENFGA_STORE_ID`), not a license flag.

  **The ruling: a non-null `resource_id` is never org-wide** — `resource_id NULL = org-wide` is the
  column's own contract — **and `org` is not a kind a grant can be scoped to**, so such a row
  confers NOTHING on both engines. The same answer covers an *unrecognised* `resource_type`
  (`resource_type` is free `text`), which used to expand to zero tuples while the Postgres PDP read
  it as an ordinary scoped grant. Both engines now route through one predicate,
  `lib/authz/grant-scope.ts`, reaching `ee/` on the existing `CoreContext.fga` seam;
  `pdp-parity.test.ts` carries the row and DERIVES its OpenFGA half from the rows Postgres holds
  (it previously composed that half from hand-written literals, which is the second, independent
  reason this control did not catch the divergence).

  **The DENY direction is CLOSED too, and it resolves to a DIFFERENT VALUE — deliberately.**
  `grantTarget` answers what a row CONFERS; a deny row is asked what it EXCLUDES, and treating one
  answer as both is fail-OPEN on the deny side (dropping the row hands back a permission both
  engines refuse). The maintainer's ruling, made knowingly:

  | effect | an uninterpretable scope… | direction |
  |---|---|---|
  | `allow` | confers **nothing** | fail-closed — an ambiguous request is not a grant |
  | `deny` | excludes the **whole org** | fail-closed — an ambiguous exclusion is not a licence |

  What is symmetric is the DIRECTION, not the value, and that is the part a future reader will try
  to simplify away. `targetForEffect` (`lib/authz/grant-scope.ts`) is the seam where the second
  question gets its own answer; `EMPTY_SCOPE_DENIES` records the decision as a named constant so
  it stays greppable and the rejected option stays visible beside it. `"the_whole_org"` is also
  what OpenFGA does for the pair today and what every deployed store's already-written tuples
  still say (`backfill` only writes), so **no deployed store's deny behaviour changes**.

  ⚠ **The deny ruling reaches a second population it was not decided on, and there it REMOVES
  access on deploy.** `grantTarget` calls two shapes uninterpretable: the `('org', <uuid>)` pair,
  and any *other* unscopable `resource_type` carrying an id (`job`, `member`, a typo — still
  writeable, since neither write boundary validates `resource_type` against `ScopableType`). The
  ruling's justification — OpenFGA already excludes the org, so no deployed store moves — is true
  of the first and **false of the second**, where OpenFGA produced no tuples at all. For that
  class the exclusion widens from one resource to the whole org on BOTH engines, with nobody
  editing anything: `backfill` re-expands raw rows on every boot, so the deploy is the change.
  No option preserves its current behaviour (a per-id exclusion on a kind with no object type is
  not expressible in OpenFGA); the alternative — dropping the row — is non-divergent but
  fail-OPEN, which is the direction the ruling rejects. Measured per row before deploy by
  `deploy_change` and `also_allowed_anywhere` in `docs/ops/grants-scope-contradictions.sql`,
  because the remediation verdict beside them answers a different question and cannot see this.

  ⚠ A third reading — "excludes only the resource it names", which is what Postgres does today —
  **is not on the menu because OpenFGA cannot express it**, and it looks like the obvious right
  answer until you try to write the tuple: the object would be `org:<project-uuid>`, which does not
  exist, and writing `project:<uuid>` instead would require KNOWING the id names a project, which
  is exactly what the row never says. That collapsed a three-way choice to two and is what the
  ruling was made on. Pinned by `pdp-parity.test.ts` (decide AND enumerate, on a project the row
  names and two it does not), `postgres-rbac-pdp.test.ts`, `ee/src/fga-tuple-sync.test.ts` and
  `tests/authz/grant-scope.test.ts` — as literals, so reverting the constant reds all four.

  ⚠ **Two consumers are still unreconciled, and neither is a test gap.** (a) Revoking such a row
  removes it and leaves the OpenFGA tuples it already wrote — before the fix because the delete
  looked at an object that does not exist, after it because the row expands to no tuples and the
  surviving ones are indistinguishable from a legitimate org-wide grant's; `backfill` only ever
  writes. (b) The access UI (`lib/queries/access-grants.ts`) facets purely on `resource_type`, so
  such a row still renders under **organization** while both engines say it confers nothing.
  Whether any of these rows EXIST is `docs/ops/grants-scope-contradictions.sql` (#4583), which
  gates the whole change and reports both classes.
- **T0 secret non-leakage over the real deploy spine.** `secret_nonleak_test.go` drives the
  persisted-metadata assembly directly. Routing a real `RunDeployV2` (kind + a SENTINEL
  `HCLOUD_TOKEN`) and asserting the token never reaches the job-log surface end-to-end depends on
  the docker/kind `e2e_local` harness; add it there so the log surface (the one with no scrubber)
  is covered by a real run, not only by construction.
- **Cross-tenant deny at the action/route boundary.** The isolation tests bite at the RLS/PDP
  layer; an end-to-end test that drives a real server action as a user-in-org-B against a
  resource-in-org-A (asserting a 403 through `authorize`) would close the last gap.
- **Secret non-leakage is a keyname DENYLIST, not a value detector.** `output_scrub` scrubs by a
  fixed list of key substrings (`kubeconfig`, `client_key`, `private_key`, …), so a *novel*
  credential-bearing output under an unmatched key (e.g. `admin_token`, `bootstrap_credentials`)
  would leak into `execution_metadata` and `secret_nonleak_test.go` (which plants sentinels only in
  denylisted keys) would not catch it. A value-shaped detector or an output *allowlist* is strictly
  stronger — track alongside the T0 log-surface item.
