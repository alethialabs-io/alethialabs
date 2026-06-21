# 08 — Runner Fleet & Multi-Cloud Autoscaling

**Status:** Built (the [runner rebuild](24-runner-rebuild-roadmap.md) Phase 7). The in-app scaler + the
**Hetzner `FleetProvider`** + **bootstrap self-registration** are implemented; the legacy AWS ECS/Lambda
fleet is retired. GCP MIG / Azure VMSS providers slot in behind the same seam when needed. (Originally
AWS-first; flipped to Hetzner-first because the hosted fleet now runs an always-warm pool — see
[20 — Managed Fleet Scheduler & Metering](20-managed-fleet-scheduler-and-metering.md) §1, where idle
per-hour price dominates and the multi-tenant scheduler/QoS layer is specced.)

## Why

The **runner** is a portable execution unit: one image that registers to a console
(`ALETHIA_WEB_ORIGIN` + token), claims jobs (`claim_next_job`, `FOR UPDATE SKIP LOCKED`), runs
Terraform, streams logs. It already runs anywhere. Two things are missing for alethialabs.io to
**operate an elastic fleet** and for the system to **run runners on any cloud**:

1. **Auto-registration** — fleet runners must self-register on boot (no manual
   `ALETHIA_RUNNER_ID/TOKEN`).
2. **Per-provider autoscaling** — scale the fleet by queue depth, on whichever cloud hosts it,
   replacing the AWS-only Lambda scaler.

Runners register either to a **self-hosted** console or to **alethialabs.io**. alethialabs.io runs
its own (potentially large) fleet to serve hosted demand; customers can also bring their own.

## 1 · Auto-registration (prerequisite)

- A console endpoint issues a runner identity in exchange for a **bootstrap token**
  (`ALETHIA_RUNNER_BOOTSTRAP_TOKEN`, org-scoped). On boot the runner self-registers → receives its
  `runner_id` + signed token (HS256, same seam as `verifyRunnerToken`), persisted to a local volume.
- Modes unchanged: **self-hosted** (native creds) vs **cloud-hosted** (assume-role / WIF /
  federated into the target account). Fleet runners = cloud-hosted.
- Keeps `claim_next_job` affinity (assigned → unassigned by `cloud_identity`) verbatim.

## 2 · The scaler (one control loop, many backends)

Replace the AWS Lambda + EventBridge with an **in-app interval** (per
[06-self-hosting-architecture](06-self-hosting-architecture.md)) that:
- reads queue depth (`QUEUED` jobs, plus `recover_stale_jobs()`),
- computes desired runner count (target backlog / per-runner throughput, min/max, cooldown),
- calls a **`FleetProvider`** to converge actual → desired.

```
type FleetProvider interface {
    Scale(ctx, desired int) error   // create/destroy runner instances
    Current(ctx) (int, error)
}
```
Default self-host profile: a fixed-size local pool (no scaler). Hosted/alethialabs.io: the scaler
loop drives one of the cloud `FleetProvider`s below.

## 3 · Provider modules (same runner image everywhere)

| Provider | Compute | Autoscale mechanism | Status |
|---|---|---|---|
| **AWS** | ECS Fargate (`infra/platform`, exists) | desired-count; move the Lambda scaler in-app | modernize first |
| **Hetzner** | `hcloud` servers (CAX) or compose replicas | hcloud API create/destroy by queue depth | build next |
| **GCP** | Managed Instance Group (or Cloud Run jobs) | MIG autoscaler / custom metric | later |
| **Azure** | VM Scale Set (or Container Instances) | VMSS autoscale rules | later |

Each module: provision a runner instance template that runs the **published runner image** in
cloud-hosted mode, pointed at `ALETHIA_WEB_ORIGIN` with the bootstrap token. IaC lives under
`infra/<provider>-runners/`; the `FleetProvider` implementation calls the provider API for
fine-grained scaling between the IaC-defined bounds.

## Sequencing
1. Auto-registration + `FleetProvider` interface + the in-app scaler loop (retire the Lambda).
2. Hetzner module (cheapest fleet; warm-pool host — see [20](20-managed-fleet-scheduler-and-metering.md)).
3. GCP, then Azure.
4. Fargate kept as a fallback `FleetProvider` for cutover/rollback.

The multi-tenant **scheduler** that rides on top of this fleet (priority, fairness, per-tier
concurrency caps, concurrent slots, metering) is specced separately in
[20 — Managed Fleet Scheduler & Metering](20-managed-fleet-scheduler-and-metering.md).

## Non-goals (for now)
- Bin-packing / spot orchestration, cross-region balancing — start with simple queue-depth scaling.
- The base control plane is **not** scaled by this loop (it's a single VM via `infra/hetzner` /
  `infra/aws-cp`); this is about the **runner** fleet only.
