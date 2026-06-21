# 22 — Per-Cloud Worker Images & Cloud-Routed Pools

**Status:** Built (Phase 3 of the [runner rebuild](24-runner-rebuild-roadmap.md)). **Routing**
(runner `supported_providers` + `claim_next_job` provider filter) and **per-cloud images**
(`Dockerfile.aws/gcp/azure` + CI; `Dockerfile.aws` build verified) are implemented. **Per-cloud warm
pools** (running those images) land with the per-cloud `FleetProvider` (the deferred Phase-4 follow-up). Follows [21 — Instant-Start Execution
Model](21-instant-provisioning-execution-model.md) and [20 — Managed Fleet Scheduler &
Metering](20-managed-fleet-scheduler-and-metering.md).

## Problem

[21](21-instant-provisioning-execution-model.md) eliminated job-start latency by baking a
fully-initialized `.terraform` (provider cache + vendored modules) into the runner image. That works,
but it trades **size** for speed, and the size grows with every cloud:

- Cloud CLIs baked into one image: google-cloud-sdk ~700 MB, azure-cli ~500 MB, aws-cli ~110 MB.
- Provider+module cache **per cloud**: ~300–700 MB each.
- An all-in-one image is already **~3.5 GB+** and grows ~1 GB per new cloud.

For any single job, almost all of that is dead weight — an AWS job never touches the Google SDK or the
Azure provider. Jobs for AWS / GCP / Azure (and future clouds) can arrive at any moment, so the naive
answer is "bake everything," which is exactly what doesn't scale.

## Decision

**Don't build one worker that does everything — build small per-cloud workers and route each job to
the right one.**

- **Per-cloud images.** A slim shared base (~240 MB: OpenTofu, kubectl, helm, infracost, git, the
  runner binary) + only that cloud's CLI and pre-initialized cache → `runner-aws`, `runner-gcp`,
  `runner-azure`, each ~1–1.4 GB. Critically the size is **flat** as clouds are added: a new
  `runner-oci` never bloats `runner-aws`. Per-cloud images share the base layers, so a registry/node
  caches the base once and only pulls the per-cloud diff.
- **Cloud-routed dispatch.** Each job already targets one cloud (`jobs.cloud_identity_id` →
  `cloud_identities.provider`). A runner declares which cloud(s) it serves; the claim filters by the
  job's provider. "Any cloud at any time" is handled by **routing**, not by a fat image.
- **Warm where it pays.** Hot clouds run `warmMin ≥ 1` (instant). Long-tail clouds run `warmMin = 0`
  (fast-cold: a small per-cloud image pull + its baked cache — far better than today). Idle cost stays
  bounded as the cloud count grows.

## Routing — the seam

- **Today** (`apps/console/lib/db/programmables.sql` `claim_next_job`, `app/api/jobs/claim/route.ts`):
  a managed runner has no `cloud_identity_id` and claims **any** unassigned job; the provider is known
  only after claim (`claim.CloudIdentity.Provider`, used in `runner.go` `executeJob`).
- **Change (minimal):** runners declare `supported_providers[]` (registration metadata or a
  `runner_providers` source); `claim_next_job` gains an optional `p_supported_providers TEXT[]` and a
  join to `cloud_identities`, adding `AND (p_supported_providers IS NULL OR ci.provider =
  ANY(p_supported_providers))`. The claim route passes the runner's declared providers. The provider is
  already returned at claim time, so no runner-side rework.

## Dual-tier fit

The dedicated-in-customer-VPC tier ([21](21-instant-provisioning-execution-model.md) §3) is
single-cloud by definition — that customer runs on their cloud. Per-cloud images make this clean: ship
them only `runner-<their cloud>`, not a 3.5 GB monster. Per-cloud images and the dedicated tier want
the same thing.

## Complement — internal mirror

Run an internal provider/module **mirror** (an artifact store of the providers + modules we use). Then
image builds are fast and hermetic (no public-registry round-trips), and cold/new-cloud pools warm
from internal storage. This is the generalized form of [21](21-instant-provisioning-execution-model.md)'s
"baked cache" — the mirror is the source of truth the per-cloud images build from.

## Notes & boundaries

- **Connectors ≠ cloud providers.** Connector providers (Cloudflare DNS, Datadog, etc.) are small and
  go in the **shared base cache layer**; they don't drive the split. Routing keys on the cloud
  providers only — `aws`/`gcp`/`azure` implemented today; the `cloud_provider` enum also reserves
  `alibaba`/`digitalocean`/`hetzner`/`civo` (not yet implemented), each of which becomes a new
  per-cloud image + pool when built.
- **Why not a shared cache volume (EFS/NFS).** Provider trees are symlink- and small-file-heavy; NFS
  latency would threaten the ~2.1 s init [21](21-instant-provisioning-execution-model.md) achieved, and
  a network volume doesn't map to the dedicated-in-VPC tier. Immutable per-cloud images win.
- **Multi-provider specs (edge case).** A spec spanning two clouds is rare; handle with a "full"
  fallback image/pool or accept a slower cold path. Don't let the 5% shape the 95%.

## Build sequence (later session)

1. Split `apps/runner/Dockerfile` into a shared **base** image + per-cloud images (base + one cloud's
   CLI + that cloud's `tofu init` pre-warm). Connector providers in the base.
2. `supported_providers[]` on runners + the provider filter in `claim_next_job` + claim route.
3. Per-cloud pools in the in-app scaler ([20](20-managed-fleet-scheduler-and-metering.md) §2), with
   per-cloud `warmMin`.
4. Internal provider/module mirror; point image builds + cold-warm at it.

## Anchors in code
- Claim/routing: `apps/console/lib/db/programmables.sql` (`claim_next_job`),
  `apps/console/app/api/jobs/claim/route.ts`, `apps/runner/internal/agent/runner.go` (`executeJob`).
- Provider source: `apps/console/lib/db/schema/cloud_identities.ts` (`provider`),
  `apps/console/lib/db/schema/enums.ts` (`cloud_provider`).
- Image: `apps/runner/Dockerfile` (today bakes all CLIs + all caches).
- Implemented providers: `packages/core/cloud/{aws,gcp,azure}_provider.go`; templates
  `infra/templates/spec/{aws,azure,gcp}`.
- Fleet: [20](20-managed-fleet-scheduler-and-metering.md) (`FleetProvider`, in-app scaler).
