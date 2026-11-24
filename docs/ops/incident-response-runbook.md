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

## 7. Named incidents

Four incidents have their own playbook because each one is likely before launch and none is a
single job or tenant. Each says how it is **detected**, what to **do first**, and what is **not built
yet** — a runbook step that names a control which does not exist is worse than no step.

### 7.1 Box loss — the production box is gone or its data is

**Detected by:** status.alethialabs.io (Console, Database and Authorization rows down — it runs on
Cloudflare, outside the box, so it stays up); the post-deploy smoke on the next deploy (`deploy-console.yml`
job `smoke`, which opens "prod: the post-deploy smoke is red on main — the deploy itself succeeded");
`backup-status.yml` (daily 06:23 UTC, from off the box) when the nightly copy stops arriving.

**Do first:**
1. Confirm it is the box and not the edge: if `get.alethialabs.io` (served by the console through the
   tunnel) and `alethialabs.io/api/health` both fail while status.alethialabs.io loads, the box or its
   tunnel is down.
2. If the old box is still reachable at all, run `backup.sh tombstones` on it before anything else —
   erasures recorded after the last hourly tombstone export are otherwise lost
   (`docs/ops/restore-runbook.md`, "Tombstones").
3. Follow **`docs/ops/restore-runbook.md`**, "A real recovery (box lost)": provision with `infra/cp-hetzner`,
   fetch the newest copy that has a `manifest.json`, verify, decrypt with the offline age key, restore
   Postgres and storage, migrate, replay tombstones, then deploy. That section is marked "has not been
   drilled"; the weekly drill (`restore-drill.yml`, Mondays) exercises the same steps on a throwaway
   EC2 instance, never on production.

**Data loss bound:** up to one night of database and storage (the nightly copy runs at 02:30 UTC), and
up to about an hour of erasure tombstones.

**Not built:** there is no scripted production restore — `scripts/ops/restore-drill.sh` accepts only
`--target drill`.

### 7.2 AI provider exhaustion — the model provider account runs out

**Detected by:** users see "The AI provider account behind this deployment is out of credit."
(`apps/console/lib/ai/provider-error.ts`); the console log carries `chat turn model error` /
`support ask model error`. When the free-tier global ceiling is reached the platform raises
`system.platform.free_ai_paused`; when the ceiling's own count query fails it lets turns through and
raises `system.platform.cost_guard_failed_open`.

**Do first:**
1. Top up the provider account. This is the only fix for paid tiers — nothing pauses paid AI.
2. To stop free-tier usage draining it again, set `ALETHIA_FREE_AI_PAUSED=1` (free tier only; paid
   plans and purchased credits keep working; users see "Free AI is paused by the platform operator").
   To narrow instead of stopping, lower `ALETHIA_FREE_AI_GLOBAL_DAILY_CREDITS` (default 20,000 credits
   per UTC day).
3. Both are read from the console's environment and take effect after a console restart.
   **Neither is emitted by `scripts/ci/deploy-console-assemble-env.sh` today**, so putting them in the
   vault does nothing: set them by hand in `/opt/alethia/.env` on the box and restart the console, and
   expect the next deploy to drop them until the assembler emits them.

**Not built:** no alert on the provider's billing error itself and no provider-balance alert — the
first operator signal is a user report or the log line.

### 7.3 Payment-hold backlog — subscriptions stuck unproven

A payment hold is a `payment_holds` row saying a subscription is not yet proven settled
(`apps/console/docs/stripe-prod-runbook.md` §7, "Payment holds"). The in-process sweeper
(`payment-hold-sweeper` heartbeat loop) advances up to 50 holds every 5 minutes.

**Detected by:** `system.platform.payment_needs_support`, raised when a hold enters `needs_operator`
or sits in one state past its bound (the table in the Stripe runbook); the console log line
`[billing] payment needs support — …`. If the sweeper itself stops, its heartbeat loop is what
`system.platform.loop_degraded` reports (§1).

**Do first:**
1. List what is open: `pnpm -C apps/console billing:payment-holds list --open`; inspect one with
   `show sub_…`.
2. If the sweeper is degraded, restart the console (§4, "A degraded/dead loop"), then
   `billing:payment-holds reconcile` to catch up.
3. Release a hold only when the subscription is proven settled:
   `billing:payment-holds release sub_… --reason "<why>" --operator <your user id>`. A missed Stripe
   event can be re-processed with break-glass `replay-webhook` (§3; break-glass is default-off).

### 7.4 Who is paged — alert routing

Today the channels that need no configuration are **GitHub issues**: a red production deploy or smoke
(`scripts/deploy-failure-report.mjs`), a failing backup check (`backup-status.yml`, label
`tracker:backup-status`), a failing restore drill ("Restore drill failing"), and workflows red across
runs (`workflow-health.yml`). Those reach the maintainer only through GitHub notifications.

Every `system.platform.*` alert (`loop_degraded`, `loop_recovered`, `payment_needs_support`,
`cost_guard_failed_open`, `free_ai_paused`) is delivered **only** when `ALETHIA_PLATFORM_ALERT_ORG_ID`
names the operator org **and** that org has a rule for the alert bound to a channel (pagerduty, slack,
email, webhook and the other types in `apps/console/lib/alerts/channels/`). Unset, each is a log line
nobody reads. The status page records incidents but sends no notification.

**To make paging real (maintainer, once):** set `ALETHIA_PLATFORM_ALERT_ORG_ID` in `alethia/prod/env`
(it is emitted by the deploy), redeploy, then in that org create one rule per alert above bound to a
channel that pushes to the maintainer's phone. Page on: `/api/health` unhealthy, `payment_needs_support`,
`free_ai_paused` and `cost_guard_failed_open`, and a `loop_degraded` that does not clear after a restart.

---

## Enablement (maintainer, one-time)
- Observability: set `OTEL_EXPORTER_OTLP_ENDPOINT` (traces/metrics), `SENTRY_DSN` (errors),
  `ALETHIA_PLATFORM_ALERT_ORG_ID` (every `system.platform.*` alert routes here — see §7.4).
- Break-glass: `ALETHIA_BREAKGLASS_ENABLED=true`, `BREAKGLASS_OPERATORS=<emails>`, and (for the
  CF-Access header path) `BREAKGLASS_ACCESS_PROXY_SECRET`; add these to the prod emit list.
- Nightly real-cloud proof: add `HCLOUD_TOKEN` (then AWS/Azure secrets) to enable `e2e-nightly.yml`.
- All are default-off — nothing here is live until enabled.

### Platform alert paging (one command)
`apps/console/scripts/ops/platform-alert-paging.ts` wires paging for every `system.platform.*` alert
in one idempotent run: it picks (or creates) the operator org, creates or reuses the channel you name,
adds one rule per event of the catalog's "Platform health" group bound to that channel, sets
`ALETHIA_PLATFORM_ALERT_ORG_ID` in `alethia/prod/env` with `--write-vault`, and ends by emitting a
`[TEST]` platform alert and reporting whether the channel accepted it. Run it with `--dry-run` first;
a second run changes nothing. The header of the script has the exact command and its inputs; the
vault value reaches the console on the next `deploy-console` run.
