# 21 — Instant-Start Provisioning: Execution Model & Dispatch

**Status:** Largely built via the [runner rebuild](24-runner-rebuild-roadmap.md): instant-init (§ caching,
Phase 0), push dispatch (Phase 1), and **concurrent slots** (§5 — supervisor + N worker subprocesses,
Phase 5) are implemented. Refines [20 — Managed Fleet Scheduler &
Metering](20-managed-fleet-scheduler-and-metering.md) §3 (which under-weighted the real bottleneck)
and builds on [08 — Runner Fleet](08-runner-fleet-autoscaling.md). Targets the **hosted/enterprise**
plane; the open-source self-host path is intentionally out of scope here.

## The problem

Enterprise users must see a queued provisioning job **start instantly** — live logs within ~1s — or
they assume they're stuck in a queue and churn. ("Instant" = instant *start + feedback*; the
Terraform itself still takes minutes. The anti-churn lever is time-to-first-log, not time-to-done.)
The question raised was whether the current poll-based "runner" is even the right execution model, or
whether we should rebuild on microVMs / ephemeral sandboxes — placing workers **both** as a shared
pool and as a dedicated pool inside the customer's own environment, fronted by a "load balancer" with
full visibility.

## Decision

**Keep the runner as a container; make it a *warm, plugin-cached, push-driven* worker, fronted by a
dispatcher control plane. One artifact serves both a shared pool and a dedicated in-VPC pool.** Do
**not** rebuild on Firecracker/Lambda/Fly. This is requirements-driven (below), not status-quo bias.

## Why — the latency is not where you'd think

Profiling the real job path (`apps/runner/internal/agent/runner.go` `executeJob`,
`packages/core/provisioner/deploy.go`, `packages/core/tofu/tofu.go`, `apps/runner/Dockerfile`),
time-to-running-job decomposes into **four independent components**:

| # | Component | Today | Cause (verified) | Fix | Substrate-dependent? |
|---|---|---|---|---|---|
| A | Claim latency | 0–10 s | 10 s poll loop (`runner.go` `pollLoop`) | push / wake-on-enqueue | no |
| B | Cold start | ~20–30 s | scale-to-zero → ~430 MB image pull | warm pool (`warmMin ≥ 1`) | partly |
| C1 | **`tofu init` provider download** | **30–120 s** | no `TF_PLUGIN_CACHE_DIR` (verified); aws/google/azurerm plugins (~300–700 MB) re-downloaded every job | plugin cache (`TF_PLUGIN_CACHE_DIR`) | **NO** |
| C2 | **`tofu init` MODULE download** | **~30–60 s** | templates pull 30+ registry modules (`terraform-aws-modules/*`, `cloudposse/*`) into `.terraform/modules` every job; no module cache exists in OpenTofu | **vendor `.terraform/modules` into the image** | **NO** |
| D | First-log lag | 1–3 s | logs buffered, **2 s flush** (`logger.go:70`); first line ~1 s in | emit on claim + notify-flush | no |

> **Measured (1.9.x/1.12.x, AWS spec template, this repo):** cold `tofu init` (empty) **123 s**;
> with provider cache but fresh workdir **57 s** (modules still re-download — C2, the miss in an
> earlier draft); copying a **fully pre-initialized** template (providers cache **+** vendored
> modules) → **2.1 s, zero network fetches**. So both C1 *and* C2 must be eliminated; the plugin
> cache alone only gets you to ~57 s.

**C1+C2 dominate, and both are substrate-independent.** No execution engine — Firecracker, Lambda,
fresh containers — fixes missing caches; only pre-warming the workdir does. The fix is to **bake a
fully-initialized `.terraform` (providers symlinked to a shared cache + vendored modules) into the
image** and have the per-job copy preserve it (the runner's `copyDir` must copy symlinks, not
dereference them). **So the existing runner + pre-initialized templates + warm pool + push +
immediate-first-log meets the SLA.** The execution-substrate debate is, for latency, a red herring;
the engineering is in **pre-warming, dispatch, and warm capacity**.

Two supporting facts from the code:
- **Warm multi-tenant reuse is already safe** — per-job temp workdirs, S3 state keyed per
  zone/project, and assume-role/WIF/federated creds set-and-**cleared-on-defer**
  (`credentials.go`, `gcp_credentials.go`, `azure_credentials.go`). Nothing leaks between jobs.
- **The tofu binary is already baked** into the image (`Dockerfile` ~L46–55); only the *provider
  plugins* are not.

## Why not the alternatives — requirements-driven

Hard constraints:
- **R1 Dual placement** — the same artifact must run as our shared pool *and* inside a customer's VPC.
- **R2 Long jobs** — deploys run 2–15+ min (2 h cap).
- **R3 Tiny team** — operational simplicity dominates; no bespoke VM orchestrator.
- **R4 Trust model** — we run the *customer's own* Terraform with *their* creds, not untrusted code →
  container isolation suffices.

| Option | R1 in customer VPC | R2 long jobs | R3 ops | R4 isolation | Verdict |
|---|---|---|---|---|---|
| **Container warm pool (the runner)** | ✅ runs on ECS/K8s/Nomad/systemd anywhere | ✅ | ✅ simplest | ✅ sufficient | **CHOOSE** |
| Firecracker microVM pool | ❌ needs kernel/rootfs/TAP/jailer host | ✅ | ❌ heavy for a small team | overkill | reject (only if untrusted code) |
| AWS Lambda (prov. concurrency) | ❌ AWS-only | ❌ **15-min hard cap** | ✅ | ✅ | reject |
| Fly Machines | ❌ SaaS, not in customer VPC | ✅ | ✅ | ✅ | reject (fails dual-tier) |

Dual-placement + long jobs + team size + trust model each independently point to containers. (If we
ever execute untrusted code — AI-generated TF, custom providers — add gVisor/Kata *per job inside the
same pool*; a hardening, not a rebuild.)

## Architecture

### 1 · Worker = warm, pre-initialized container
- **`warmMin` always-on** workers per tier/region; scale *up* on queue depth, never below `warmMin`.
  Kills **B**.
- **Bake a fully pre-initialized template** per provider into the image: run `tofu init -backend=false
  -upgrade` at build so each `spec-templates/{aws,azure,gcp}` ships with `.terraform/providers`
  (symlinked into a shared `TF_PLUGIN_CACHE_DIR`) **and** `.terraform/modules` (vendored registry
  modules). The per-job `copyDir` copies this tree (preserving the provider symlinks), so job-time
  `tofu init` re-runs only the S3 backend step. Kills **C1 + C2** → ~2 s. (Self-host/local runs without
  the baked tree fall back to warm-on-first-job via the cache.) An exclusive `filesystem_mirror` +
  `tofu providers mirror` is a stricter offline variant (later hardening).
- **Emit first-log on claim** ("▸ Job claimed — preparing workspace…") and replace the fixed 2 s flush
  with a notify-driven flush (`logger.go`). Kills **D** → sub-second first-log.

### 2 · Dispatch = held-connection push + Postgres NOTIFY fanout (the "load balancer")
- Workers hold a long-lived connection **to our HTTPS API** (SSE/WebSocket/gRPC stream) — **never to
  our DB**. A worker in a customer VPC therefore only ever speaks HTTPS to the control plane (today's
  auth boundary, preserved).
- On enqueue, the control plane wakes the target pool over those connections; the woken worker runs
  the normal authenticated `claim_next_job` (`FOR UPDATE SKIP LOCKED`). Cross-API-instance fanout uses
  Postgres `NOTIFY` (same pattern as the log SSE in `lib/realtime` / `app/api/stream`).
- The dispatcher keeps a **live registry** (liveness + free slots) built on the existing heartbeat +
  `sweep_offline_runners` → the visibility asked for, plus instant failover: on worker death it
  re-wakes peers; `recover_stale_jobs` remains the backstop.
- Removes the 10 s poll (**A**) without a bespoke protocol; a richer push channel can come later.

### 3 · Dual tier from one artifact
- **Shared "Instant" pool** — our env, warm, multi-tenant (safe per R4); horizontal concurrency = pod
  count. The default hosted experience.
- **Dedicated pool** — same image, a small **always-warm, HA (2+) pool inside the customer's VPC**,
  registered over HTTPS. Single-tenant → isolation trivial, plugin cache local, and
  **execution/data never leave their environment** — the zero-trust thesis as a premium SKU.

### Latency after
First-log < 1 s (D) · claim < 0.5 s (A) · no cold start (B) · `tofu init` ~2 s (measured, C1+C2) vs
57–123 s today. The "5-second" churn risk is solved — and the biggest wins (C + D) are config + a
build step, not a rewrite.

## Branding & tiering (recommendation; naming is a marketing call)
- Don't expose "runner"/"queue" to users — sell the capability: **instant provisioning** and
  **dedicated provisioning capacity**.
- Tiers map to **placement + warmth + concurrency**, not a raw throughput meter:
  - **Instant (shared)** — warm shared pool; hosted default.
  - **Dedicated / Private Runners (enterprise)** — in-VPC, always-warm, HA, data-resident.
  - **Self-managed** — BYO worker (OSS/self-host); kept separate.
- Throughput/concurrency stays an **expansion** lever (see [20](20-managed-fleet-scheduler-and-metering.md),
  [14](14-gtm-pricing.md)), not the headline.

## Build sequence (ROI order — each shippable alone)
1. **Pre-initialized templates (providers cache + vendored modules) + emit-first-log-on-claim +
   notify-flush.** ✅ Done — removes ~75 % of perceived latency (C1+C2+D), `tofu init` 57–123 s → ~2 s
   (measured). Touch points: `packages/core/tofu/tofu.go` (`ensurePluginCache`),
   `packages/core/provisioner/deploy.go` (`copyDir` preserves symlinks),
   `apps/runner/internal/agent/logger.go` (notify-flush), `runner.go` (emit on claim),
   `apps/runner/Dockerfile` (bake `.terraform`). Tests: logger latency/coalescing, `ensurePluginCache`,
   `copyDir` symlink preservation, `cache_integration_test.go` (tagged).
2. **`warmMin` warm pool** in the in-app scaler (20 §2) — removes cold start (B).
3. **Held-connection push + dispatcher registry** (NOTIFY fanout) — removes the poll (A); live fleet
   view. Reuses heartbeat / `sweep_offline_runners` / SSE patterns.
4. **Dedicated-in-VPC packaging** — one-command deploy of the warm pool into a customer account,
   registering over HTTPS. The enterprise SKU.
5. **Concurrency** only if pod-per-job economics demand it (more pods first; goroutine+subprocess
   isolation per slot later). Defer until measured.

## Open questions
- **Image size tradeoff** — RESOLVED by [22 — Per-Cloud Worker Images](22-per-cloud-worker-images.md):
  baking all clouds' caches grows the image ~1 GB per cloud; the answer is per-cloud images + routing,
  not one fat image.
- Plugin-cache delivery: baked image layer (chosen) vs cache volume vs internal provider mirror.
- Push transport: SSE vs WebSocket vs gRPC stream for the worker↔API channel.
- `warmMin` sizing + scale-up curve per tier/region; dedicated-pool default size (2 for HA?).
- Branding/naming sign-off.
- Untrusted-code horizon (AI-generated TF / custom providers) → if it arrives, add gVisor/Kata per job.

## Anchors in code
- Poll loop + per-job execution: `apps/runner/internal/agent/runner.go` (`pollLoop`, `executeJob`).
- Init / plugin download: `packages/core/provisioner/deploy.go`, `packages/core/tofu/tofu.go`
  (**no `TF_PLUGIN_CACHE_DIR` — verified**).
- Per-job isolation/cleanup: `credentials.go`, `gcp_credentials.go`, `azure_credentials.go`.
- Log flush (2 s): `apps/runner/internal/agent/logger.go:70`.
- Image (tofu baked, plugins not): `apps/runner/Dockerfile` (~L46–55).
- Realtime/dispatch primitives: `apps/console/lib/realtime`, `apps/console/app/api/stream`,
  heartbeat + `sweep_offline_runners` + `claim_next_job` (`apps/console/lib/db/programmables.sql`).

## References
- [OpenTofu provider plugin cache](https://oneuptime.com/blog/post/2026-03-20-opentofu-plugin-cache/view)
- [Firecracker vs gVisor — operational complexity (Northflank)](https://northflank.com/blog/firecracker-vs-gvisor)
- [AWS Lambda 15-minute timeout limit (AWS docs)](https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html)
