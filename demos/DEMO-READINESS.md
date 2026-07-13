<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Demo readiness — live status ledger + road to a multi-cloud live demo

Living tracker for the **hosted, multi-cloud, live end-to-end demo** (Hetzner + AWS/Azure managed,
template **and** BYO IaC). Companion to [`README.md`](./README.md) (the scenario pitch ledger). Update
the status column as each phase lands.

**Two hard truths this ledger exists to keep honest:**

1. **Nothing new is hosted.** `main` (what the prod box serves) is ~#294. The whole 5-cloud
   parity + BYO IaC build (#295–#333) is on `dev` only, deployed nowhere. Deploy fires only on push
   to `main`.
2. **The spine now runs live against a real (kind) cluster; real *cloud* apply is still unproven.**
   The `tofu apply → kubeconfig → CNI → reachability → ArgoCD → addons` hero chain is CI-green +
   `tofu validate`-clean on 5 clouds, and — new — the **T1 E2E keystone (#348)** drives the FULL
   `RunDeployV2` spine via the **real runner binary** against a **real `kind` cluster**, asserting
   `cluster_ready` + a verified ed25519 receipt sealed to the plan hash + shipped job-logs + an
   independent `kubectl get nodes`, with guaranteed teardown (merge-queue-gated so it can't hollow
   out). So "never run against a real cluster once" is **retired for the local/kind case**. What
   remains unproven: a real **cloud** `tofu apply` (Hetzner/AWS/Azure) — CI does no cloud apply, and
   there is still **no committed real-*cloud* proof artifact** (the T2 nightly tier + `demos/proofs/`
   capture are the next step). The stale `feat/e1-hetzner-proof` branch (~#289) holds only a template
   fix, not a proof.

Status legend: ✅ **WORKING** (tested / runnable now) · 🟡 **CODE-ONLY** (built + CI-green, never run
live) · 🔒 **BLOCKED-BY-DESIGN** (fail-closed until a named gate) · 📋 **PLANNED / NOT BUILT**.

---

## Status ledger

| Capability | Status | Note |
|---|---|---|
| verify engine (elench controls, ed25519 receipts, customer-plan + manifest audit) | ✅ WORKING | `go run ./packages/core/verify/cmd/elench-verify` |
| drift `Analyze` → Posture + DETECT_DRIFT cron dispatch | ✅ WORKING (unit) | live refresh-only run unproven |
| iacsafety fail-closed static gate | ✅ WORKING (unit) | 3 P0 RCE bypasses + 1 P1 closed & re-verified |
| scanner / multi-repo merge / classification | ✅ WORKING (unit) | |
| 5-cloud tofu templates | ✅ `validate`/tflint/Trivy · 🟡 plan/apply | live `tofu plan` per cloud never run (#311 discipline) |
| ArgoCD render + InfraFacts + per-cloud workload identity + honest infra-service decisions | ✅ WORKING (golden tests) | actual `kubectl apply` unproven |
| console UX (connect → canvas → deploy → SSE logs → clusters/evidence/addons) | ✅ WORKING | polished; empty until a real cluster exists |
| Talos template plan-out deployability (helm_template → `bootstrap_manifests` output, post-apply kubectl) | ✅ resolved on dev | via #301; the stale e1-branch's `8aef7f19` fix is superseded — **E1 is not blocked by this** |
| `RunDeployV2` apply → kubeconfig → CNI → reachability/datapath gates (#288/#301/#307/#308) | ✅ real **kind** (T1) · 🟡 real **cloud** | full spine runs live vs a real kind cluster via the **real runner binary** — `cluster_ready` + verified receipt + kubectl (T1 #348, merge-queue); real-cloud apply still unproven |
| ArgoCD/addons `kubectl apply`, health, security read-back | 🟡 CODE-ONLY | exercised by T1 on kind (CNI ships, ArgoCD installs); cloud read-back unproven |
| Evidence console surface | ✅ as UI · 🟡 upstream cluster data | reads DB rows a real deploy must write |
| BYO IaC self-hosted (`operator=self`) | 🟡 CODE-ONLY | GA path; cheapest live-proof candidate (zero-spend module) |
| BYO IaC managed-fleet (untrusted) | 🔒 BLOCKED-BY-DESIGN | fail-closed until the 3b sandbox canary |
| managed hcloud fleet (scaler + warm pools + per-job OIDC) | 🟡 CODE-ONLY | **no-op without a `fleet_pools` DB row** |
| connectors (server-side verify, 5 clouds) | ✅ WORKING (unit) · 🟡 platform setup | Hetzner = zero platform setup; managed = OIDC issuer + per-cloud app |
| **hosted deployment of #295–#333** | 📋 NOT DONE | dev-only; prod runs ~#294 |
| product-data seeder / demo org | 📋 NOT BUILT | fresh org = empty Clusters/Evidence/Addons |
| demo-path dead-ends (agent "deploy coming soon"; SSO/DO/Civo/Volume "coming soon") | 📋 hide/steer | near the happy path |

---

## Operability substrate — the "know what's happening / fix it" half (prove · know · correct · recover)

The E2E + observability + state-hardening + ops program riding under this roadmap (plan:
`abundant-meandering-grove`). This is what makes a hosted demo *survivable* and the provisioning
chain *trustworthy*, distinct from the demo-path capabilities above. Waves 1–4 (below) are merged to
`dev`; each shipped research → adversarial-grill → build → verify, with SQL proven against real
Postgres.

| Capability | Status | Note |
|---|---|---|
| Tiered provisioning E2E — **T0** in-process (every PR) + **T1** real-runner→real-kind (merge-queue) | ✅ WORKING | #337 (T0) + #348 (T1); asserts `cluster_ready` + signed receipt (non-vacuous) |
| Real-infra **T2** nightly (Hetzner→AWS→Azure) + `demos/proofs/` capture | 📋 PLANNED | the real-**cloud** proof; feeds Phase 1–2 |
| Structured JSON logging + W3C **traceparent** correlation (console + runner) | ✅ WORKING | #338 (migration 0076) |
| **OpenTelemetry** traces (real console↔runner join) + low-cardinality metrics | ✅ WORKING (OTLP-gated no-op) | #346; drop-on-full — a collector outage can't backpressure a provision |
| **env-status CAS** — no more last-writer-wins clobber (late DEPLOY-SUCCESS can't resurrect a DESTROYED env) | ✅ WORKING | #339 (`set_env_status` programmable); all writes routed |
| **Safe mid-flight cancel** — SIGINT-first (no orphaned resources), sticks, heartbeat fallback, `force_release` unlock | ✅ WORKING | #340 |
| **fleet_actions** audit ledger + **poison-job cap** + progress heartbeat | ✅ WORKING | #345 (migrations 0077/0078); `recover_stale_jobs` atomic |
| Compliance corpus (labeled + mutation, false-PASS=0) + **multi-provider** verify union | ✅ WORKING | #336 + #341; SOC 2 regression anchor |
| Transactional heal + drift scheduler + ephemeral reaper + log/ledger GC (B2c) | 🟡 in flight | convergence backstop for a dropped env-status update |
| Security E2E (authz/PDP-parity · secret non-leak · sandbox-escape · fail-closed gates) | 📋 building | non-vacuous, through the real pipeline |
| Self-hosted error tracking (GlitchTip) · ops dashboard + deep `/health` + break-glass | 📋 PLANNED | the "fix it" surface + loop supervision |
| Incident-response / on-call / DR runbook | 📋 PLANNED | keyed on the job's traceparent |

---

## Roadmap (dependency- and risk-ordered)

Retire the real-apply unknown **first**, cheaply, locally — before hosting, managed clouds, BYO, or
polish. Hosting is a risk multiplier, not a feature.

| Phase | Goal | Owner | Status |
|---|---|---|---|
| **0** | This ledger + Artifact dashboard + rollback record + budgets | auto + maintainer | ✅ done (#334) |
| **0.5** | Operability substrate (E2E T0/T1 · logs/traces/metrics · env-CAS · safe-cancel · ledgers) | auto | ✅ waves 1–4 merged |
| **1** | **E1** — first real Hetzner/Talos cluster, LOCAL (the #1 derisk) | maintainer (live infra) | 📋 — T1 kind proof (#348) de-risks the spine; real-cloud apply still maintainer-gated |
| **2** | **E2** — first managed cloud (AWS→Azure): live plan→apply→destroy | maintainer (cloud + spend) | 📋 |
| **3** | Hosting — promote dev→staging→main; prove provisioning on prod | maintainer (promote + vault) | 📋 |
| **4** | 3b sandbox canary → managed-fleet BYO IaC (self-runner fallback) | maintainer (real-VM proof) | 📋 |
| **5** | Demo polish — persistent demo clusters + seeder; hide dead-ends | auto + maintainer | 📋 |
| **6** | Rehearsal, multi-cloud runbook, fallback | maintainer | 📋 |

**Rollback point (before any promotion):** `main` = `3813dd1b` (#294).

---

## Phase 1 — E1 run recipe (execute this to cross the biggest chasm)

Cheapest possible real cluster: local runner + a Hetzner token → Talos `cax11@nbg1`. ~$5, minutes.

```bash
# 1. Local stack (Postgres + SeaweedFS + OpenFGA + console on :3000)
pnpm dev:up

# 2. Ensure a bootstrap token exists and the console loaded it
grep ALETHIA_RUNNER_BOOTSTRAP_TOKEN .env   # dev:runner auto-generates one if missing;
FORCE=1 pnpm dev:up                        # restart the console so it loads the token

# 3. A real provisioning runner — docker mode = full tofu + cloud CLI toolchain
MODE=docker CRED=bootstrap PROVIDERS=hetzner pnpm dev:runner
pnpm dev:runner:logs                       # follow it

# 4. In the console (http://localhost:3000): connect Hetzner (paste an hcloud API token),
#    create a project, design a Talos cluster on the canvas, click Deploy (Pending-changes bar).

# 5. Watch the DEPLOY job's SSE logs at /{org}/~/jobs/{id}.
```

**Watch these seams (fixes exist on dev, all unproven live):**
- **Talos Cilium CNI** (`infra/templates/project/hetzner/cilium.tf`) — top failure suspect: does the
  `helm_template`-rendered Cilium apply cleanly and own pod networking on a real Talos node.
- **ArgoCD redis pre-seed** (`ensureArgoRedisSecret`, `packages/core/provisioner/deploy.go`) — first
  real ArgoCD bring-up on Talos (the exit-20 redis-secret-init race the pre-seed targets).
- **Reachability + datapath gates** (`packages/core/k8s/probe.go`, #288/#307/#308) — SUCCESS is gated
  on a working cluster; datapath may be single-node on a one-`cax11` design.

**Capture the proof (it does not exist yet):**
```bash
# From the runner / console, save:
#   - the full DEPLOY job SSE log
#   - the ed25519 verify receipt (Evidence → receipt download)
#   - the kubeconfig + `kubectl get nodes,pods -A`
#   - ArgoCD Applications health
# Commit them under demos/proofs/e1-hetzner/<date>/ on a fresh branch off dev.
# Then DESTROY the cluster and re-run once to confirm repeatability (not a fluke).
```

---

## Maintainer-gated checklist (what needs real infra / accounts / spend)

- [ ] **P1** Hetzner API token; local Docker; run E1; commit proof; destroy.
- [ ] **P2** AWS account + budget cap; `ALETHIA_OIDC_SIGNING_KEY` + **publicly-reachable JWKS**;
      `infra/connector-platform/aws` role trust applied; `ghcr.io/alethialabs-io/runner-aws` published;
      live `tofu plan` reviewed; apply→destroy; then Azure (customer managed identity — no platform app).
- [ ] **P3** promote dev→staging→main (squash-reconcile); prod vault flags (OIDC key);
      `fleet_pools` row with `warm_min ≥ 1`; re-prove E1+E2 on the prod domain.
- [ ] **P4** real-VM canary (nested podman + IMDS-unreachable + squid egress); flip
      `FLEET_SANDBOX_CONTAINER` → `_EGRESS_ENFORCED=1` → `_ENFORCE_MANAGED=1`; `ALETHIA_BYO_IAC_ENABLED=true`;
      prove BYO IaC on the fleet (self-runner fallback if it slips).
- [ ] **P5** pre-provision persistent demo clusters (non-ephemeral lifecycle, #289); optional seeder.
- [ ] **P6** two timed prod rehearsals + fallback drill.

## Biggest live-demo risks (ordered)

1. apply→cluster→ArgoCD tail breaks on real infra (Talos Cilium CNI top suspect) → P1 retires it first, ~$5.
2. managed OIDC/JWKS handshake misconfigured → P2 proves with public JWKS; P3 re-proves on prod domain.
3. promotion squash-conflict / prod secret drift → reconcile staging/dev to main after each squash.
4. "waiting for runner" hang → `fleet_pools` warm_min ≥ 1 + pre-demo runner-health check.
5. empty-org cold start → persistent demo clusters + seeder.
6. 3b canary slips (weeks) → self-runner BYO fallback keeps the beat.
7. live-provision latency on stage (managed 5–15 min) → lead with fast Hetzner, kick managed early, choreograph.
