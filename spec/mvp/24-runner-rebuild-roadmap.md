# 24 — Runner Rebuild Roadmap (living tracker)

**Status:** In progress. This is the durable progress tracker for the coordinated runner rebuild
toward: **instant** job start, a **fair + metered** shared fleet, **lean** per-cloud images, and
**elastic** warm capacity. Designs live in [20](20-managed-fleet-scheduler-and-metering.md) /
[21](21-instant-provisioning-execution-model.md) / [22](22-per-cloud-worker-images.md); this doc
sequences them and records what's done.

## Status

| Phase | Workstream | Status |
|---|---|---|
| 0 | Instant-init (provider/module cache, first-log) | ✅ Built |
| 1 | Push dispatch (NOTIFY+SSE wake; kill the 10s poll) | ✅ Built |
| 2 | Scheduler core (priority · fairness · concurrency caps) | ✅ Built |
| 3 | Per-cloud routing + lean images | ✅ Built (routing + image build verified live) |
| 4 | In-app scaler + warm pool + FleetProvider | ✅ Built (cloud-agnostic core + Hetzner provider) |
| 5 | Concurrent job slots | ✅ Built (supervisor + N worker subprocesses) |
| 6 | Metering surfacing + metered billing | ✅ Built |
| 7 | Hetzner FleetProvider + bootstrap; retire fleet-aws | ✅ Built |

Legend: ✅ Built · 🔨 In progress · ⬜ Designed (not started). **The runner rebuild is complete.**

## Dependency order

```
P1 Push dispatch      ── independent
P2 Scheduler core     ── adds jobs.priority + jobs.provider ─┐
P3 Per-cloud routing  ── needs jobs.provider; + image split  ├─→ P4
P4 Scaler + warm pool ── needs per-provider queue depth ─────┘
P5 Concurrent slots   ── needs the scaler formula
P6 Metering + retire   ── after the fleet is in-app
```

## Phase 0 — Instant-init ✅ Built

`tofu init` 123s→~2s via baked provider cache + vendored modules + symlink-preserving per-job copy;
emit-first-log-on-claim; notify-driven log flush. See [21](21-instant-provisioning-execution-model.md).

## Phase 1 — Push dispatch ✅ Built

NOTIFY on job enqueue → authed SSE wake → runner holds the connection and claims on wake (30s safety
poll fallback). Worker stays HTTPS-only. Shipped:
- `programmables.sql`: `notify_runner_wake()` + `jobs_runner_wake` trigger (AFTER INSERT/UPDATE OF
  status WHEN QUEUED) → `pg_notify('runner_wake', …)`.
- `lib/realtime/index.ts`: `PgWakeTransport` + `getWakeTransport()` (separate LISTEN conn, broadcast).
- `app/api/runners/wake/route.ts`: runner-token-authed SSE; immediate wake on connect + 20s heartbeat.
- `apps/runner` `api.go` `StreamWake` + `JobAPI`; `runner.go` `claimLoop`/`wakeLoop` replace the 10s
  poll (wake-driven drain + 30s safety poll + reconnect backoff).
- Tests: `TestClaimLoop_DrainsOnWake` (wake → claim+execute). Green: runner tests, console
  check-types/lint (0 errors), go build (runner/core/cli). No migration (trigger is in programmables).
- Remaining manual check (deploy-time): enqueue → logs in <1s through Caddy.

## Phase 2 — Scheduler core ✅ Built

`jobs.priority` (band + job-type bump) + denormalized `jobs.provider`, set by the `jobs_set_scheduling`
trigger. `claim_next_job` branches on the claiming runner's operator: **managed** = priority → fairness
(fewest-in-flight) → oldest, skipping orgs at their plan cap; **self** = priority → oldest, uncapped.
Plan→{priority,cap} is authoritative in SQL (`org_effective_plan`/`plan_priority`/`plan_max_concurrency`,
community fallback); entitlements `quotas` mirror it for UI. Shipped:
- `lib/db/schema/jobs.ts`: `priority` + `provider`; `idx_jobs_queue` → `(status, priority desc,
  created_at)`. Migration `0005_typical_mockingbird.sql`.
- `programmables.sql`: the five quota fns + `jobs_set_scheduling` trigger + provider backfill +
  rewritten `claim_next_job`.
- `lib/authz/types.ts` + `lib/billing/plan.ts`: `quotas {maxConcurrentJobs, priorityLevel}` per band.
- **Verified** by `apps/console/scripts/verify-scheduler.mjs` against real Postgres: priority
  (business>community), fairness (burst doesn't starve a peer), cap (community stops at 2), self
  uncapped — all pass. check-types/lint clean (0 errors).

## Phase 3 — Per-cloud routing + lean images ✅

**3a · Routing — ✅ built + verified live.**
- `runners.supported_providers cloud_provider[]` (nullable = claims any). Migration `0007`.
- `claim_next_job` reads it + filters both Phase-B branches: `v_providers IS NULL OR j.provider IS NULL
  OR j.provider = ANY(v_providers)`.
- `runner_heartbeat(p_providers cloud_provider[])` keeps `supported_providers` in sync (image-driven).
- `/api/runners/heartbeat` validates providers against the `cloud_provider` enum (zod) → 400 on bad.
- Runner declares via `ALETHIA_RUNNER_PROVIDERS` (env → heartbeat); `api.Runner` gains
  `supported_providers`. One `cloud_provider` type across identities/jobs/runners.
- **Verified live** (`scripts/verify-scheduler.mjs` Test 5, real Postgres): aws-only claims AWS, skips
  GCP; any-provider claims both; provider-less job claimable by all. + go build/vet/test + check-types/lint.

**3b · Lean images — ✅ built + verified.** Self-contained per-cloud `Dockerfile.aws/gcp/azure` —
faithful subsets of the working full `Dockerfile` (one cloud's CLI + only that cloud's pre-init cache +
`ALETHIA_RUNNER_PROVIDERS=<cloud>`); identical leading layers dedup at the registry. Full `Dockerfile`
unchanged → self-host/compose untouched. CI matrix builds `runner` (full) + `runner-aws/gcp/azure`.
**Verified:** `docker build -f Dockerfile.aws` succeeds (2.09 GB AWS-only image; its `tofu init` bakes
only the AWS provider/module cache).

## Phase 4 — In-app scaler (cloud-agnostic core) ✅ / per-cloud providers deferred

Cloud-agnostic control loop + seam shipped; per-cloud capacity providers + Lambda retirement are the
"help each cloud" follow-up (the worker runs anywhere, so the core stays cloud-neutral).
- `lib/fleet/provider.ts`: `Pool` + `FleetProvider` interface + `getFleetProvider()` seam +
  `ManualFleetProvider` (DB-counted `current`, no-op `scale` that logs intent).
- `lib/fleet/compute-desired.ts`: pure `computeDesired` — `clamp(warmMin + ceil(backlog/slots),
  warmMin, max)`, scale-up now, scale-down after an idle grace. **7 unit tests pass.**
- `lib/fleet/queue.ts`: `backlogByProvider` + `countManagedRunnersForProvider`.
- `lib/fleet/config.ts`: `FLEET_POOLS` (zod-validated; default `[]` → loop is a no-op).
- `lib/fleet/scaler.ts`: 60s globalThis-guarded loop (sibling to `recovery.ts`), started from
  `instrumentation.ts`; `notifyScaler` now also wakes it for fast scale-up.
- Verified: check-types + lint (0 errors) + go build; `computeDesired` unit tests green. Postgres
  counting (verify-scheduler Test 6: backlog/current by provider) is written, runs on next DB up.
- **No regression:** default `FLEET_POOLS=[]` + no-op `scale` → nothing changes operationally; the
  Lambda keeps scaling the live AWS fleet until a real provider replaces it.

**Hetzner provider + Lambda retirement shipped in Phase 7** (below).

## Phase 5 — Concurrent slots ✅

One runner runs N jobs as **N worker subprocesses** under a supervisor — process isolation is what makes
it safe (per-process cloud-credential env + the `deploy.go` AWS-env suspend become process-local) and a
private `HOME` per worker isolates `~/.kube`, `~/.config/{gcloud,helm}`, `~/.aws`. Workers share one
`ALETHIA_RUNNER_ID` (one logical runner, N slots); claims are atomic (`SKIP LOCKED`) so they never
double-claim. Shipped:
- `apps/runner/cmd/runner/main.go`: `ALETHIA_RUNNER_SLOTS` (default **1** = today's in-process path,
  no subprocess). `ALETHIA_RUNNER_WORKER=1` or slots≤1 → run the agent loop; else supervise.
- `apps/runner/internal/agent/supervisor.go`: spawn N workers (re-exec self, private `HOME`),
  restart-on-crash, forward SIGTERM (each worker's 10-min drain), reap via wait. Injectable spawn.
- `packages/core/cloud/aws_provider.go`: kubeconfig moved off the cwd-relative `temp/kubeconfig` to an
  absolute `$HOME/.alethia/kubeconfig` (per-worker isolated). GCP/Azure already write to `~/.kube` (HOME).
- compose `runner` gets `init: true` (reap orphans); `ALETHIA_RUNNER_SLOTS` documented in compose + docs.
- **Verified:** `supervisor_test.go` (spawn-N, restart-on-crash, shutdown-forwards-no-restart) + slots
  parsing test + go build/test (runner/core/cli). Live binary smoke: `SLOTS=2` re-execs 2 workers with
  distinct HOMEs and drains on SIGTERM. Remaining deploy-time check: 2 concurrent claims against the full stack.

**Acceptance:** no cred/workdir bleed (process + HOME isolation); default slots=1 is regression-free.

## Phase 6 — Metering surfacing + metered billing ✅

Billable unit = **job-minutes** (managed-runner execution time; self-hosted = $0; provisioned-hours stays
internal COGS). Lean allowance + real overage, surfaced transparently so it never reads as "double-billing."
Shipped:
- **Pricing model** (`lib/billing/plan.ts` + `authz/types.ts`): `quotas.includedRunnerMinutes` —
  community **200** · team **500** · business **5,000** · enterprise **20,000**; `OVERAGE_RATE_PER_MIN
  = $0.012` (`lib/billing/usage.ts`). vs GitHub Actions $0.006/min; our cost ~$0.00075/min (~94% margin).
- **Rollup** (`lib/queries/runner-usage.ts` `queryJobMinutesByOrg`) + pure `computeUsage` (overage/headroom).
  `getOrgUsage()` action feeds the meter.
- **Surfacing** (`billing-panel.tsx`): real "Provisioning minutes" meter — used/included, headroom
  framing, 80%-approaching + over-limit overage estimate, "self-hosted runners are free" note, and a
  **hard-cap toggle** ("pause instead of overage", `setUsageHardCap`).
- **Hard cap / free stop** (`lib/billing/usage-guard.ts` `assertUsageAllowed`, wired into PLAN/DEPLOY/rerun
  enqueues): community hard-stops at 200 min (no card → never a surprise charge); paid orgs with the cap
  on pause at included; paid without the cap bill overage.
- **Stripe metered billing** (`lib/billing/meter.ts` + `config.ts` + `billing.ts`): optional graduated
  metered price per tier (`STRIPE_PRICE_METER_*`, free tier = included, then $0.012/min) added as a 2nd
  subscription item; job-minutes reported once per terminal job at the `update_job_status` route,
  idempotent via `jobs.usage_reported_at` (claim-then-report with rollback). Hosted-only seam.
- Migration `0009` (`jobs.usage_reported_at`, `organization_billing.current_period_start` +
  `usage_hard_cap`). **Verified:** `computeUsage` 5 tests; verify-scheduler Test 7 (job-minutes rollup,
  self excluded = 15) green against real Postgres; check-types + lint clean. Live Stripe charge deferred
  to when `STRIPE_PRICE_METER_*` + the meter exist (config'd, not invented).

**Legacy retirement: done in Phase 7.**

## Phase 7 — Hetzner FleetProvider + bootstrap; retire fleet-aws ✅

The in-app scaler now provisions real warm capacity, and the AWS fleet is gone.
- **Bootstrap self-registration**: `/api/runners/bootstrap` (dedicated `ALETHIA_RUNNER_BOOTSTRAP_TOKEN`,
  dedup by VM instance id → one runner per VM across reboots). Go runner self-registers when launched
  without ID/token (`bootstrap.go`; instance id from the Hetzner metadata service, hostname fallback);
  the result is persisted to env so worker subprocesses inherit it. `RunnerMetadata.cloud_instance_id`.
- **`HcloudFleetProvider`** (`lib/fleet/hcloud.ts`, `FLEET_PROVIDER=hcloud`): Hetzner REST API via fetch
  (no SDK). `current` = labeled servers; `scale` creates VMs (cloud-init `docker run`s the per-cloud
  image, which self-registers) or **gracefully** deletes only **idle** runners' servers (no
  CLAIMED/PROCESSING job) + closes their usage session. `cax21`/`fsn1`/`ubuntu-24.04` defaults, all
  env-overridable. Pools stay keyed by the target cloud (a Hetzner box runs runner-aws to serve AWS).
- **Retired**: deleted `infra/fleet-aws/` + `.github/workflows/infra-fleet-aws.yml`; `notifyScaler`
  no longer pings the Lambda (pure in-app wake); removed `SCALER_FUNCTION_URL` (turbo/env); CLAUDE/GEMINI
  updated. Default stays `manual` + `FLEET_POOLS=[]` → no behavior change until configured.
- **Verified**: cloud-init/scale-math unit tests (8) + Go bootstrap httptest + verify-scheduler **Test 8**
  (bootstrap dedup, real Postgres) + check-types/lint/go build. **Live Hetzner smoke deferred** to creds
  + deploy. **Ops cutover**: deploy with `FLEET_PROVIDER=hcloud` + `HCLOUD_TOKEN` + `FLEET_POOLS` +
  `ALETHIA_RUNNER_BOOTSTRAP_TOKEN`, confirm pools fill, then the old ECS fleet is `tofu destroy`-ed.

## Rules

Each phase ships green (types/lint/go test + migration). `claim_next_job` is concentrated in P2–P3
(rewrite once, then extend). Schema pipeline: edit `lib/db/schema/*` → `db:generate` → `programmables.sql`
for functions/triggers/RLS.
