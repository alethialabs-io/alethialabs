<!-- Moved out of the user docs (apps/docs, /concepts/runner/architecture, /log-streaming, /scaling, /job-execution/*) by the concepts rework: contributor material. -->

# Runner and fleet internals

Code map for the runner and the managed fleet described in
[Runners](https://alethialabs.io/docs/concepts/runner).

## Runner

- Main loop: `apps/runner/internal/agent/runner.go` — `heartbeatInterval = 30s`,
  `shutdownGracePeriod = 10m`, the claim loop (wake stream + safety poll) and the job-type dispatch
  switch (one case per `provision_job_type`; a missing case is a compile error).
- Handlers: `executePlan`, `executeDeploy`, `executeDestroy`, `executeDeployRunner`,
  `executeDestroyRunner`, `executeAnalyzeRepo`, `executeDriftDetection`, `executeAudit`,
  `executeChartScan`, `executeIacScan`, `executeStateSurgery`, `executeProbeCluster`
  (`probe.go`), `executeBuild` (`build.go`), `executeMintKubeconfig` (`kubeconfig_mint.go`).
- Plan binding: `plan_binding.go` (refusal codes posted as `plan_binding_refusal`).
- Credentials: `gcp_credentials.go` (`ActivateGcpOIDC`), Azure `ActivateAzureFederated`, AWS profile
  writer; cluster tokens via `runner kube-token` (`kube_token.go`).
- Logs: `logger.go` — two `JobLogger`s per job, flush within ~100 ms of a write, at 10 KB, on a 1 s
  ticker and at the end; `POST /api/jobs/{id}/logs` → `insert_job_log` → `NOTIFY job_logs`.
- API client methods: `ClaimJob`, `Heartbeat`, `UpdateJobStatus`, `SendLog`, `UploadPlanArtifact`,
  `DownloadPlanArtifact` (see [runner-apis.md](./runner-apis.md)).
- Sandbox seam: `packages/core/sandbox` (`Passthrough` / `Container`), see its README.

## Queue recovery

`recover_stale_jobs()` in `apps/console/lib/db/programmables.sql`: dead runner (claimed > 15 min,
no heartbeat in `runner_liveness_window()` = 5 min) or stalled (no progress for 30 min). Requeues,
except when `execution_metadata.apply_started_at` is set (terminal `FAILED`, `orphan_risk`) or at
`max_attempts` (5). Runners go offline after 45 s without a heartbeat.

## Fleet scaler (`apps/console/lib/fleet/`)

| File | Role |
| --- | --- |
| `scaler.ts` | 60 s tick (`TICK_INTERVAL_MS`), `wakeFleetScaler()` on enqueue, one pass per process, leader lease (`tryBecomeFleetLeader`) |
| `plan.ts` | Pure `plan(project, observed)`; `targetCount` |
| `controller.ts` | Applies actions idempotently, records `fleet_actions`, inner `tryFleetScaleLock` |
| `provider.ts` | `getFleetProvider()` (`FLEET_PROVIDER`: `manual` or `hcloud`) |
| `hcloud.ts` | Hetzner provider over the REST API |
| `pools-db.ts` | Loads enabled `fleet_pools` rows each tick |
| `fake-provider.ts` | Fake world for unit tests |

VMs self-register with `ALETHIA_RUNNER_BOOTSTRAP_TOKEN` at `POST /api/runners/bootstrap`; unused
tokens are swept by `sweepBootstrapTokens`; billing sessions live in `runner_usage_sessions`.

## Schedulers on the reconcile loop (`apps/console/lib/reconcile/loop.ts`)

Drift (`lib/drift/schedule.ts`, `DRIFT_CADENCE_MS`), probes (`lib/probes/schedule.ts`,
`PROBE_CADENCE_MS`), the ephemeral-environment reaper (`lib/reconcile/reap.ts`) and env-status
convergence.
