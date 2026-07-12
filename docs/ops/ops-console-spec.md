<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Ops console — design spec (for Claude Design)

This is a **design spec, not an implementation**: the data model, views, and states for two operator
surfaces. Hand it to Claude Design for the visual/interaction design; the backend each screen reads is
already on `dev` (see "Data sources"). Follow the Alethia design language (grayscale, status by
dot-shape + mono label never hue, `@repo/ui` primitives, reuse existing patterns like the evidence
drawer / addon sheet).

Two surfaces, deliberately separated by blast radius:

1. **Ops dashboard** — read-only "is the platform healthy, what is it doing". Safe, observable.
2. **Break-glass console** — privileged "fix a stuck thing". Dangerous, gated, audited. **A separate
   auth boundary from the dashboard** (see §2.4).

---

## 1. Ops dashboard (read-only)

**Job to be done:** an on-call operator opens this and, in one screen, answers: *is every background
loop alive? is the queue moving? which jobs are stuck/poisoned? are runners/fleet healthy? is anything
drifted or failing?* — without touching a DB.

### 1.1 Data sources (all already on `dev`)
| Section | Source | PR |
|---|---|---|
| Platform loops | `GET /api/health` (deep readiness) — `loops[]` + `db` + `otel` | #356 |
| Fleet actions | `fleet_actions` table (create/drain/destroy/noop + reason + queue_depth + pool_size) | #345 |
| Jobs (in-flight/stuck/poison) | `jobs` (status, attempts/max_attempts, progress_at, traceparent) | #345 |
| Runners | `runners` (status, last_heartbeat, supported_providers) | existing |
| Env drift | drift posture per env (DETECT_DRIFT records) | existing/#352 |
| Metrics (optional) | OTLP → the operator's own Grafana; dashboard links out, doesn't re-plot | #346 |

### 1.2 Views (data model per tile)

**A. Platform health banner** (top, always visible) — the aggregate from `/api/health`.
- `status: "healthy" | "degraded" | "unhealthy"` → one dot-shape + mono label.
- `db: { reachable, latencyMs }`.
- `ts`, `version`.
- Rule: `unhealthy` (DB down) is the loud state; `degraded` (a loop stuck) is the attention state —
  **surface `degraded` prominently even though `/health` returns HTTP 200 for it** (a grill finding:
  operators watching status codes miss degraded).

**B. Background loops** — one row per `loops[]` entry from `/health`.
- `id` (job-recovery, fleet-scaler, alert-scheduler, connection-sweeper, reconcile).
- `status: "starting" | "ok" | "degraded"` (dot-shape).
- `ageMs` (since last success) · `intervalMs` · `runs` · `failures` · `lastError`.
- reconcile row expands to its `tasks[]` (env-convergence, ephemeral-reaper, drift-schedule,
  gc-job-logs, gc-fleet-actions) — each with lastRunAt/lastSuccessAt/lastErrorAt/failures.
- State: a degraded loop is the primary alert surface.

**C. Job queue** — derived from `jobs`.
- Counters: `queued`, `processing`, `stuck` (progress_at older than the stall window), `poison`
  (attempts ≥ max_attempts, failed-terminal), recent `failed` (last N).
- Per stuck/poison job row: `id`, `job_type`, `status`, `attempts/max_attempts`, `progress_at`,
  `runner_id`, `project`/`env`, `traceparent` (deep-link to the operator's trace tool).
- State severity: poison = critical, stuck = warning.

**D. Fleet** — from `runners` + `fleet_actions`.
- Runner rows: `id`, `status` (ONLINE/OFFLINE/DRAINING), `last_heartbeat` age, `supported_providers`.
- Fleet-action feed (answers "why did the fleet do that at 3am"): reverse-chron `fleet_actions` —
  `created_at`, `provider`, `action`, `count`, `reason`, `queue_depth`, `pool_size`.

**E. Drift & environments** — envs whose latest drift posture is `drifted`, and envs in a non-settled
status (QUEUED/PROVISIONING/DESTROYING) longer than expected (the convergence backstop's input).

### 1.3 States & interactions
- Read-only. No mutations. Every "fix" action links to the break-glass console (§2), which requires a
  separate auth step — the dashboard never mutates.
- Empty states are honest ("No stuck jobs", "All loops healthy").
- Auto-refresh (SSE or poll) — reuse the admin SSE pattern.
- Severity encoding: dot-shape + mono label (`OK`/`DEGRADED`/`STUCK`/`POISON`/`CRITICAL`), never hue.

---

## 2. Break-glass console (privileged, gated, audited)

**Job to be done:** during an incident, an authorized operator performs a *specific, blast-radius-bounded*
recovery action that the normal product UI can't (or shouldn't) do — and every action is audited.

### 2.1 Actions catalog (data model per action)
Each action: a typed input, a required typed-confirm, a blast-radius label, and an append-only audit row
written **before** the action executes.

| Action | Input | Backend (exists / to build) | Blast radius |
|---|---|---|---|
| Inspect job | job_id | read (exists) | none |
| Retry job | job_id | re-enqueue (respects poison cap) | low |
| Cancel job | job_id | `cancelJob` (#340, safe SIGINT-first) | low |
| Unstick env | env_id, target_status | `set_env_status` CAS (#339) — from an explicit expected_from | medium |
| Drain / restart runner | runner_id | fleet action | medium |
| Replay webhook | webhook_event_id | re-dispatch (idempotent) | low |
| Force-release state lock | state_key | `force_release_tofu_state_lock` (#340 — rotates+fences) | **high** |
| State surgery | env_id + op | a **privileged job type** (never raw SQL — keeps fencing intact) | **high** |
| Orphan detect → clean | env_id/run | detect first, then run-scoped clean | **high** |

### 2.2 Confirmation & two-person model
- Every action: **typed-confirm on the exact resource id/slug** (no bare "are you sure").
- **High-blast-radius** actions (force-unlock, state surgery, orphan-clean, force-destroy): require a
  **two-person / time-boxed token** — a second authorized operator approves within a short window, or a
  break-glass token minted out-of-band. Show who approved.
- **Audit-before-act:** the append-only audit row (`actor`, `action`, `resource`, `input`, `reason`,
  `approver`, `ts`) is committed **before** the mutation runs, so an action that then fails is still on
  the record.

### 2.3 Views
- **Action picker** grouped by blast radius (none/low/medium/high), high visually set apart.
- **Confirm sheet** per action: the exact resource, the typed-confirm field, blast-radius label, the
  reason field (required), and (for high) the approval state.
- **Audit log** — append-only, filterable by actor/action/resource/time. This is also compliance
  evidence (CC6/CC8), so it must be immutable + exportable.
- **Active break-glass session banner** — who is in break-glass, since when (a break-glass session is
  itself an audited, time-boxed thing).

### 2.4 Auth boundary (the security-critical part — do NOT co-locate on the read-only admin surface)
- A **separate auth boundary** from the read-only ops dashboard and from the existing read-only
  cross-tenant admin (`admin.alethialabs.io` / Cloudflare Access): a distinct Access app or a stronger
  second factor. Being able to *read* is not being able to *act*.
- **`ALETHIA_BREAKGLASS_ENABLED` default-off.** The console 404s/redirects unless explicitly enabled per
  deployment.
- Every entry into break-glass opens an **audited, time-boxed session**.
- Mirror the actions as **CLI ops verbs** (`apps/cli/cmd/ops_*.go`) hitting the same audited endpoints —
  same auth, same audit, for terminal-first operators.

---

## Backend status (what the spec's screens read/call)
- **Read side is done:** `/api/health` (#356), `fleet_actions` (#345), `jobs`/`runners`/drift.
- **Break-glass backend is to-build:** the privileged server actions + the isolated auth boundary +
  the append-only audit + the two-person token + the `ops_*` CLI verbs + the state-surgery privileged
  job type. Some primitives already exist and are reused, not re-invented: `cancelJob` (#340),
  `set_env_status` (#339), `force_release_tofu_state_lock` (#340, fencing-preserving).

## Notes
- Placement: this spec lives in the main repo alongside the backend it describes; the maintainer may
  prefer to move the *product/feature* framing to the private `dataroom/spec/features/`.
- Nothing here is UI code — it is the data model + view/state contract for Claude Design.
