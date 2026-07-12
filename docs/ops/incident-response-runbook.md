<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Incident-response, on-call & DR runbook

The operator's playbook for the Alethia control plane: **detect → triage → act (break-glass) → recover
(DR) → escalate**. It references the observability + ops surfaces built by the operability program;
every stage is keyed on one correlation id — the job's **W3C `traceparent`** — so ops debugging and
test-failure debugging use the same thread.

> Break-glass and the observability collectors are **default-off**. This runbook assumes a maintainer
> has enabled them (see "Enablement" at the end); until then most "act" steps 404 by design.

---

## 0. One correlation model: the traceparent

Every provisioning job carries a `traceparent` (migration 0076). It ties together:
- **Structured logs** (console + runner JSON logs) — filter by `trace_id`.
- **Traces** (OTel, if `OTEL_EXPORTER_OTLP_ENDPOINT` set) — one span tree enqueue→claim→stage→apply→
  gates→callback, console↔runner joined.
- **Errors** (GlitchTip, if `SENTRY_DSN` set) — each event tagged `trace_id`/`job_id`.
- **The job row** — `jobs.traceparent`, `job_logs.traceparent`.

Start every investigation from a `trace_id` (or `job_id`) and pivot across logs/traces/errors with it.

---

## 1. Detect

| Signal | Where |
|---|---|
| Platform degraded/unhealthy | `GET /api/health` (deep readiness) — aggregate + per-loop liveness. **`degraded` returns HTTP 200** (a stuck loop doesn't 503 the instance) — watch the BODY / the alert, not just the status code. |
| A background loop stuck | `/api/health` `loops[]` (`degraded`) + the `system.platform.loop_degraded` alert (the independent watcher raises it even if the reconcile loop itself died). |
| Poison / stuck jobs | `jobs.attempts >= max_attempts` (poison, failed-terminal) / `progress_at` stale (stuck). Ops dashboard "Job queue" tile. |
| Fleet churn | `fleet_actions` ledger (why the fleet created/drained/destroyed + queue depth). |
| Orphan risk after a cancel | `system.project.orphan_risk` alert (a mid-apply cancel flagged possible orphaned cloud resources). |
| Env stuck in-flight | env in QUEUED/PROVISIONING/DESTROYING longer than expected → the B2c convergence backstop should self-heal within its staleness window; a persistent one is a signal. |

Liveness vs readiness: `GET /api/health?probe=live` (or `?shallow=1`) is the cheap, DB-free liveness
probe (restart signal); the default deep readiness is the drain signal.

## 2. Triage

1. Get the `trace_id`/`job_id` from the alert or `/health` or the failing job row.
2. Pull the **logs** for that trace (console + runner). Read the stage the job died on.
3. If OTel/GlitchTip are on: open the **trace** (which stage, how long) and the **error** (stack, tags).
4. Classify blast radius: single job? one env/tenant? a whole loop (platform-wide)? the DB?

## 3. Act — break-glass (blast-radius-bounded, audited)

Use the **break-glass console** (or `alethia ops …` CLI) — a **separate, gated, audited** surface
(`ALETHIA_BREAKGLASS_ENABLED`, distinct `BREAKGLASS_OPERATORS`). Every action writes an append-only
`breakglass_audit` row **before** it runs; high-blast actions need a **second operator's approval**.

| Symptom | Action | Blast | Notes |
|---|---|---|---|
| Job wedged | `inspect-job` → `retry-job` / `cancel-job` | low | cancel is SIGINT-first (no orphans); retry respects the poison cap |
| Env stuck in an in-flight status | `unstick-env <env> <target>` | medium | goes through the `set_env_status` CAS (explicit expected-from; a miss is a 409, never a clobber) |
| Runner hung / bad | `drain-runner` / `restart-runner` | medium | |
| Billing event needs re-processing | `replay-webhook <event>` | low | re-processes STATE only — emails AND the payment retry are suppressed by default |
| Stale tofu-state lock blocking apply | `force-release-lock <state_key>` | **high** (2-person) | rotates lock_id + bumps the fencing generation (never a naive delete) → a zombie writer is fenced |
| Orphaned cloud resources | `orphan-detect <project>` (read-only) | high | detect is run/project-scoped read-only; **orphan-clean is INERT** — never an account-wide delete (a scoped clean is deliberate future work) |
| Corrupt tofu state | `state-surgery` | **high** (2-person) | enqueues a privileged job through the normal fenced pipeline; the runner executor is **INERT** today — refuses, touches no state |

Everything an action does is in the `breakglass_audit` log (immutable — a WORM trigger blocks
update/delete/truncate even for the service role). That log is also compliance evidence (SOC2 CC6/CC8).

## 4. Recover — DR

- **Stale lock → apply won't start:** `force-release-lock` (above). It fences the old holder, so a
  resurrected zombie writer can't corrupt state under the new apply.
- **tofu state backup/restore:** state lives in the S3-compatible object store behind the fenced
  HTTP state proxy. Restore from the object-store version history; after a restore, `force-release-lock`
  so a fresh apply re-acquires with a bumped generation. (Automated state snapshots are a maintainer
  runbook step; capture before any state surgery.)
- **DB:** the append-only ledgers (`breakglass_audit`, the customer `audit_log`, the signed verify
  receipts) are the forensic record — restore-from-backup preserves them; they are never rewritten in
  place.
- **A degraded/dead loop:** loops are per-instance in-memory; a rolling restart re-registers them.
  Confirm recovery on `/health` (`starting`→`ok`) and the `loop_recovered` alert.

## 5. Escalate

Route through the existing `system.*` alert channels (the alerts catalog). Page on: `/health`
`unhealthy` (DB down), a `loop_degraded` that doesn't clear after a restart, `orphan_risk`, or a
force-destroy. Include the `trace_id` in the escalation so the next responder starts from the same thread.

## 6. Proving it keeps working (don't wait for a real incident)

- **T2 nightly** (`e2e-nightly.yml`) exercises the real provisioning spine against a real cloud
  (Hetzner first) and captures proofs into `demos/proofs/` — a standing "does it still provision + tear
  down cleanly" check.
- **Drift scheduler** (B2c) keeps re-proving deployed envs match their desired state.
- A **game day**: enable break-glass in a staging deployment, drive a simulated incident (wedge a job,
  stale a lock), and walk this runbook end-to-end.

---

## Enablement (maintainer, one-time)
- Observability: set `OTEL_EXPORTER_OTLP_ENDPOINT` (traces/metrics), `SENTRY_DSN` (errors),
  `ALETHIA_PLATFORM_ALERT_ORG_ID` (loop-degraded alerts route here).
- Break-glass: `ALETHIA_BREAKGLASS_ENABLED=true`, `BREAKGLASS_OPERATORS=<emails>`, and (for the
  CF-Access header path) `BREAKGLASS_ACCESS_PROXY_SECRET`; add these to the prod emit list.
- Nightly real-cloud proof: add `HCLOUD_TOKEN` (then AWS/Azure secrets) to enable `e2e-nightly.yml`.
- All are default-off — nothing here is live until enabled.
