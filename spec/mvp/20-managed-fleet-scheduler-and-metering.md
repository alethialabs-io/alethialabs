# 20 — Managed Runner Fleet: Multi-Tenant Scheduler & Metering

**Status:** Partially built (via the [runner rebuild](24-runner-rebuild-roadmap.md)). The multi-tenant
**scheduler** (§4 — priority · fairness · concurrency caps) is **implemented** (Phase 2); the in-app
**scaler control loop + `FleetProvider` seam** (§2) is **implemented cloud-agnostically** (Phase 4); the
**metering → metered-billing** model (§5 — job-minutes, included allowance, $0.012/min overage, Stripe
graduated meter) is **implemented** (Phase 6); the first **per-cloud capacity provider** (§3 — Hetzner
`HcloudFleetProvider` + bootstrap self-registration) is **implemented** (Phase 7), retiring the legacy
AWS fleet. The count-only scaler (§2–3) has since been superseded by the **Fleet Controller**
([26](26-fleet-controller.md)) — a declarative reconciler over immutable VMs (health · count · version ·
placement) with connection-based instant liveness and zero-downtime rolling updates. **The runner rebuild
is complete** (GCP MIG / Azure VMSS providers slot in behind the same seam when needed).
Extends [08 — Runner Fleet & Autoscaling](08-runner-fleet-autoscaling.md); references
[14 — GTM & Pricing](14-gtm-pricing.md) and [17 — Cost Model](17-cost-model-and-pricing.md).

## Why

`operator=managed` runners (the Alethia Labs fleet that many tenants share) are now a first-class
concept — [the runner reframe](../../apps/console/lib/db/schema/runners.ts) split `mode` into
`operator`/`provisioning` and added the `runner_usage_sessions` metering ledger. This doc answers the
three operational questions that reframe surfaced:

1. **How do we run the shared fleet, and where?** (placement + scaling)
2. **How do we make it faster / more efficient?** (warm pool, concurrent slots, priority)
3. **How do we meter it for money?** (mechanics on the existing ledger; pricing framing deferred)

**08 already specs** auto-registration (bootstrap token) and the in-app scaler driving a
`FleetProvider`. **This doc adds** the multi-tenant *scheduling* layer (QoS: priority, fairness,
per-tier concurrency, warm pool, concurrent slots), the *metering mechanics*, and flips the fleet
build order to **Hetzner-first**.

A note on positioning (decided open in [14](14-gtm-pricing.md)): throughput/concurrency is an
**expansion lever on a hosted "Managed Runners" convenience tier**, not the pricing floor. The runner
is AGPL and ephemeral — it only orchestrates Terraform; the heavy compute (EKS, Aurora) lives in the
customer's own cloud (see [17, "the cost boundary"](17-cost-model-and-pricing.md)). Anyone can
self-host the runner and get unlimited concurrency for free, so raw throughput is a weak moat. What
sells is the *convenience of us running it* — zero infra, instant (warm) starts, burst concurrency.
The floor stays per-seat governance + FinOps. **Pricing framing is deferred; this doc specs only the
mechanics and the `ee/` seams they hang on.**

---

## 1 · Where the fleet runs — Hetzner-first

08's table lists AWS→Hetzner→GCP→Azure. We flip to **Hetzner-first** for the hosted fleet. The
reason is *not* generic "cheap" — [17](17-cost-model-and-pricing.md) correctly shows hosting choice
barely moves gross margin **under scale-to-zero** (runner-minutes are <2% of revenue). The flip is
driven by the **warm pool** decision (§3):

- Scale-to-zero makes Fargate cheap because you only pay for the burst. A **warm pool runs idle 24/7**
  so the *per-hour idle price* dominates, and there Hetzner CAX (Ampere ARM) is multiples cheaper than
  Fargate's ~$0.045/hr-equiv. Warm-pool economics, not burst economics, justify the switch.
- Many **concurrent slots per runner** (§4) also favor a fat cheap box over many small Fargate tasks
  (no per-task overhead).

**Topology:**
- A shared always-warm pool per region, **EU + US** to start. Runners are network-bound orchestrators
  (they talk to cloud control-plane APIs), not compute farms, so a couple of regional pools cover
  latency + data residency; **no per-customer or per-region job pinning** (claim affinity stays
  `cloud_identity`-based, verbatim from 08).
- Backends behind the `FleetProvider` interface (08 §2): **Hetzner `hcloud` first**, GCP MIG second,
  **Fargate demoted to a fallback** provider. Same published runner image everywhere.
- Auth unchanged: managed runners assume-role / WIF / federate into the customer account; the control
  plane never stores cloud creds. Reuse the `cloud_identity.provider` switch already in the runner.

---

## 2 · The scaler moves in-app (kill the Lambda)

The current `infra/fleet-aws/scaler/lambda/index.py` (EventBridge 1-min cron, toggling
`desiredCount` 0↔1 on hardcoded single-task services) is a prototype. Replace it with a **second
in-app loop**, modeled exactly on `apps/console/lib/jobs/recovery.ts` (`startStaleJobRecovery`, 60s,
idempotent, started from `instrumentation.ts`), behind the `FleetProvider` interface from 08.

- **Algorithm upgrade** — scale by queue depth instead of on/off:
  `desired = clamp(ceil(backlog / slotsPerRunner) + warmMin, 0..max)`, with a cooldown to avoid
  thrash. `backlog` = `QUEUED` count from the same probe `/api/platform/queue` already returns;
  `warmMin` keeps the pool from going fully cold (the "instant provision" guarantee).
- **One loop, both profiles:** self-host = fixed pool (no `FleetProvider`, `warmMin` = pool size);
  hosted = the loop drives the `hcloud` `FleetProvider`. Identical code path.
- This folds the scaler into the same self-contained control plane as recovery/sweep — no Lambda, no
  separate infra, nothing AWS-specific in the hot path.

---

## 3 · Faster & more efficient

> **Correction (see [21 — Instant-Start Execution Model](21-instant-provisioning-execution-model.md)):**
> a later profiling pass found the **dominant** start-latency cost is not cold start — it is
> `tofu init` re-downloading ~300–700 MB of provider plugins every job (no `TF_PLUGIN_CACHE_DIR`),
> 30–120s. The **#1 "faster" lever is a provider-plugin cache** (plus emitting first-log on claim);
> warm pool and the levers below come after. 21 is the authoritative execution-model design.

Levers, in corrected ROI order:

- **Provider-plugin cache + immediate first-log** (from 21) — removes ~75% of perceived latency; do
  first.
- **Warm pool** — removes cold start. Today scale-from-zero eats a 20–30s image pull before a job even
  claims. A `warmMin` of always-ready runners makes provisions start *immediately*. The premium
  "instant provision" feature and part of the reason for Hetzner-first (§1, warm-pool economics).
- **Concurrent job slots per runner** — today a runner runs **one job at a time, serially**
  (`apps/runner/internal/agent/runner.go` poll loop, 2h per-job timeout). Provisioning is
  **I/O-bound** (waiting on cloud APIs), so a single runner can safely run *N* jobs in parallel given
  **isolated workdirs + distinct S3 state keys** (state keys already per-spec). The runner reports its
  `slots` so the scaler's depth math (§2) stays correct. A cheap multiplier on throughput and on
  idle-pool utilization.
- **Priority + fairness in the queue** — §4. Pure-Postgres, no new infra.

---

## 4 · The multi-tenant scheduler (pure Postgres, extends `claim_next_job`)

The queue is already a Postgres-native job queue (`claim_next_job`, `FOR UPDATE SKIP LOCKED` in
`apps/console/lib/db/programmables.sql`). Every QoS feature below is an **extension of that RPC + the
`jobs` table** — no Kafka/Temporal/Redis.

- **Priority.** Add `priority smallint not null default 0` to `jobs`
  (`apps/console/lib/db/schema/jobs.ts`). Both claim phases order
  `ORDER BY priority DESC, created_at ASC` (today: `created_at ASC` only). Plan tier sets priority at
  insert (resolved from entitlements). Index `idx_jobs_queue` becomes `(status, priority, created_at)`.
- **Per-tenant fairness.** A 500-job burst from one org must not monopolize a shared pool. The claim
  picks the oldest eligible job belonging to the org with the **fewest in-flight jobs** (a fairness
  sub-select inside the RPC; `CLAIMED`+`PROCESSING` count per `org_id`). Single RPC change, still one
  `SKIP LOCKED` claim. (Open question §9: fewest-in-flight vs weighted round-robin.)
- **Per-tier concurrency caps.** Max in-flight jobs per org, by plan. Enforced through the existing
  entitlements seam (`lib/billing/`, `lib/authz/entitlements.ts` `getEntitlements`) — **extend it to
  return `{ features, quotas }`**, with `quotas.maxConcurrentJobs`. Checked at claim (RPC returns null
  once the org is at cap, so its jobs wait) and/or at insert (reject/queue). The cap values live in
  `ee/`, never in core — community returns unlimited.
- **Warm pool & slots** feed the scaler (§2/§3): the scheduler decides *what* runs next; the scaler
  decides *how many runners* exist.

All four compose: a high-priority job from an org under its concurrency cap, picked fairly across
orgs, claimed atomically into a free slot on a warm runner.

---

## 5 · Metering mechanics (on the ledger we shipped)

The substrate exists: `runner_usage_sessions` (one row per managed ONLINE→OFFLINE interval) +
`apps/console/lib/queries/runner-usage.ts` (`queryProvisionedHours`, window-clamped) +
`getManagedRunnerUsage`. Mechanics to add:

- **Billable unit (open — §9):** *provisioned-hours* (ledger, what we meter today) vs *job-minutes*
  (per-job from `jobs.started_at/completed_at`). They diverge once concurrent slots exist — one warm
  runner-hour can bill many job-minutes. Add a per-job-minutes rollup alongside the existing
  provisioned-hours so either unit is available; pick the billable one when pricing is decided.
- **Quotas via the entitlements seam.** `quotas` (§4) also carries `includedRunnerMinutes` and
  `priorityLevel` per plan. Overage = metered usage beyond the included allowance, computed off the
  ledger rollup. Seam lives in `ee/`; community = no metering, no caps.
- **Live signals for free.** "Approaching quota" / live usage rides the existing LISTEN/NOTIFY SSE
  (`lib/realtime`, `app/api/stream`) — no new transport.
- **Pricing framing deferred.** Numbers and tier mapping are placeholders here; [14](14-gtm-pricing.md)
  owns the floor (per-seat + FinOps), this is the expansion meter.

---

## 6 · Why the post-Supabase stack makes this cheap to build

Everything above lands on what already exists. Postgres is the entire backbone:

| Capability | Mechanism (already built) | What §1–5 add |
|---|---|---|
| Job queue | `claim_next_job`, `FOR UPDATE SKIP LOCKED` | priority + fairness + cap (RPC edits) |
| Realtime | LISTEN/NOTIFY → SSE (no Redis) | quota/usage signals (reuse) |
| Recovery | in-app 60s loop (`recovery.ts`) | the scaler is a sibling loop |
| Tenancy | transaction-scoped RLS (`org_id`) | fairness/cap key off `org_id` |
| Metering | `runner_usage_sessions` ledger | job-minutes rollup + overage |
| Entitlements | `getEntitlements` (`ee/` seam) | extend to `{ features, quotas }` |

A fair, metered, multi-tenant scheduler is an **extension of the RPC + ledger we already have** — no
new dependencies. One self-contained control plane, **identical self-hosted and hosted** (the only
difference is whether the scaler loop has a `FleetProvider`).

---

## 7 · Migration off the legacy `infra/fleet-aws`

- Decommission the Lambda scaler + EventBridge and the 4 hardcoded ITGix-domain single-task services.
- Stand up the `hcloud` `FleetProvider` + in-app scaler (§2) behind the bootstrap-token
  auto-registration from 08.
- Keep `claim_next_job` affinity and the `/api/platform/queue` probe (now also driven by the in-app
  loop, not only the Lambda — already wired: the queue route calls `recover_stale_jobs` +
  `sweep_offline_runners`).
- Rollback: the legacy Fargate path stays a `FleetProvider` fallback during cutover; flip back by
  pointing the scaler at it.

---

## 8 · Build sequence (each independently shippable)

1. `priority` column + claim RPC ordering (`jobs.ts`, `programmables.sql`).
2. Per-tier concurrency caps — extend `getEntitlements` → `{ features, quotas }`; enforce at claim/insert.
3. Per-tenant fairness sub-select in `claim_next_job`.
4. In-app scaler loop + `warmMin` (sibling to `recovery.ts`) behind the `FleetProvider` interface.
5. Hetzner `hcloud` `FleetProvider` + `infra/hetzner-runners/`.
6. Concurrent job slots per runner (isolated workdirs + state keys; report `slots`).
7. Metering rollups (job-minutes) + overage off the ledger; quota surfacing via SSE.

---

## 9 · Open questions

- **Pricing positioning** — expansion lever vs primary axis (deferred; my recommendation: expansion).
- **Billable unit** — provisioned-hours vs job-minutes (they diverge under concurrent slots).
- **Fairness algorithm** — fewest-in-flight vs weighted round-robin by plan weight.
- **Default `slots` per runner** — and the right Hetzner box size for it.
- **US pool provider** — Hetzner US vs GCP MIG.

---

## Anchors in code (verify before building)

- Queue/RPC: `apps/console/lib/db/programmables.sql` (`claim_next_job`, `recover_stale_jobs`,
  `sweep_offline_runners`, `open_runner_session`).
- Jobs schema: `apps/console/lib/db/schema/jobs.ts` (`idx_jobs_queue`; no `priority` yet).
- Metering: `apps/console/lib/db/schema/runners.ts` (`runner_usage_sessions`),
  `apps/console/lib/queries/runner-usage.ts`, `getManagedRunnerUsage`.
- Scaler/loops: `apps/console/lib/jobs/recovery.ts`, `apps/console/instrumentation.ts`,
  `apps/console/app/api/platform/queue/route.ts`, `apps/console/lib/scaler.ts`.
- Runner agent: `apps/runner/internal/agent/runner.go` (poll loop, serial execution).
- Entitlements seam: `apps/console/lib/billing/`, `apps/console/lib/authz/entitlements.ts`.
- Legacy fleet to retire: `infra/fleet-aws/` (Lambda scaler + ITGix services).
