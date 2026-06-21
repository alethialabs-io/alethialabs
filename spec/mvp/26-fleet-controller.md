# 26 — Fleet Controller: always-on managed runners

**Status:** Built (controller core) — verified against a fake provider + real Postgres; live Hetzner
stand-up deferred until `HCLOUD_TOKEN` is provided. Supersedes the count-only scaler from
[20 §2–3](20-managed-fleet-scheduler-and-metering.md); the per-cloud provider is [22](22-per-cloud-worker-images.md);
fits the runner rebuild [24](24-runner-rebuild-roadmap.md).

## Why

Paying users must **never** hit "no runner available." The Phase-4 scaler reconciled *count* only, used a
slow 5-min heartbeat-stale liveness, and had no story for **rolling version updates** of deployed runners.
We need always-on capacity, instant failure detection, and zero-downtime updates — **rock solid + easily
manageable, without running a Kubernetes/Nomad cluster** (a cluster to manage the runners that build
clusters is recursive ops overhead, and Hetzner has no managed ASG/MIG to lean on).

## Decision: one declarative controller over immutable VMs

A single reconciliation loop makes reality match a declarative **pool spec** — the k8s-controller pattern,
without k8s. Runners are **immutable**: never mutated in place; any change (version, unhealthy, rebalance)
= drain + replace. "Update" and "heal" are the same op: *replace any runner that doesn't match desired*.

**Pool spec** (`FLEET_POOLS`): `{ provider, version|channel, warmMin, max, slotsPerRunner, locations[],
minPerLocation, surge, buffer, scaleDownGraceTicks }`. The brain is a **pure planner**
`plan(spec, observed) → Action[]` (`create`/`drain`/`destroy`), exhaustively unit-tested; the controller
just gathers `observed` (provider.list ⨝ DB runner state + backlog + recent-peak) and applies actions.

It reconciles four axes in priority order, under one hard invariant — **never plan online capacity below
the warm floor**:
1. **Health** — a dead runner (offline, or unregistered past a boot grace) → reap (+ replace via count).
2. **Count** — warm floor `= clamp(max(warmMin, max(recentPeak, ⌈backlog/slots⌉) + buffer), 0, max)`
   (N+1 auto-grow); create up to it (placement-aware), reap idle surplus after the grace window.
3. **Placement** — keep `minPerLocation` across ≥2 locations so a DC outage never zeroes the pool.
4. **Version** — outdated runners: surge a replacement first, then drain (one per tick), bounded by
   `surge`, never below the floor → zero-downtime rollout. Channel resolves to the newest `runner_releases`.

## Instant liveness — the connection is the signal

The runner holds a persistent SSE wake connection. `runner_present` refreshes a `last_heartbeat` lease on
connect + every ~10s ping; **`runner_lost` fires the instant the connection drops** (`req.signal` abort) →
sub-second detection for clean drops, and a tightened 45s sweep covers hard partitions. Heartbeat polling
is no longer the liveness path. Multi-replica safe (Postgres-backed; `pg_notify('runner_lost')` wakes the
controller on any replica).

## Drain protocol (no new signalling)

The controller marks an outdated/surplus runner `DRAINING`; `claim_next_job` early-returns for DRAINING
runners, so they stop claiming, finish their current job, go idle, and get reaped. That's the whole
protocol — no runner↔server drain channel.

## Manageability + why not a cluster

One spec + one reconciler = the whole fleet; change `warmMin`/`version`/`locations` and reality converges.
A Fleet view + alerts (engine exists) surface warmMin breaches, stalled rollouts, lost locations. **k8s** =
heavy/recursive ops; **Nomad** = another Raft cluster to run; **custom controller** = no new infra, runs in
the console we already operate, purpose-fit, and we own the exact semantics.

## Implementation

- `lib/fleet/`: `types.ts` (spec/instance/action), `plan.ts` (pure planner), `controller.ts`
  (gather→plan→apply, DB hooks injected via `ControllerDeps`), `db-deps.ts` (live deps), `provider.ts`
  (`list/create/destroy` seam + manual no-op), `hcloud.ts` (Hetzner REST), `fake-provider.ts` (test world),
  `config.ts` (`FLEET_POOLS`), `queue.ts` (DB queries), `scaler.ts` (the 60s loop host).
- `programmables.sql`: `runner_present`/`runner_lost`, DRAINING-claim exclusion, 45s sweep.
- `wake/route.ts`: presence on connect/ping, lost on drop. Migration `0017`: `runners.location`,
  `target_release_id`.
- **Default off**: no `FLEET_POOLS` → no-op; `FLEET_PROVIDER=hcloud` activates the real provider.

## Verification

`plan.test.ts` (14) — every axis + a 30-tick rollout asserting online ≥ warmMin each tick + convergence.
`controller.test.ts` (5, vs the fake) — cold start, rollout, crash self-heal, channel resolution, auto-grow
up+down. `hcloud.test.ts` (5) — cloud-init/payload. verify-scheduler Tests 9–10 (real Postgres) —
DRAINING claims nothing + presence functions. **Deferred:** live Hetzner `list/create/destroy` + a
2-location stand-up (when `HCLOUD_TOKEN` arrives) — its logic is fake-tested; the REST calls are thin.

## Open / next
GCP MIG + Azure VMSS providers behind the same seam; canary (cap new-version to 1 until first success);
the Fleet view UI + pool-health alert rules; auto-grow tuning (decaying peak vs instantaneous).
