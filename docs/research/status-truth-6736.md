# Status truth: one environment described three ways (#6736)

On production, project `a640` (Azure, environment `development`) read three ways that cannot all be
true. The cluster card said PROVISIONING, "1 / 1 healthy", control plane AKS ACTIVE, and offered a
kubeconfig. The environment card said Deploying, Drifted, "Updated 4 months ago". The evidence
page's drift scan, from 7 days earlier, said `azurerm_resource_group.main` was DELETED.

This note traces each of those to the code that produces it. Line numbers are for `dev` at
`a3badaff6`, the base of the fix. The production database was not read. Where the cause depends on
rows nobody looked at, this note says so.

## 1. Where each displayed state comes from

### The cluster card (`/[org]/~/clusters`)

| What it showed | Source | Writer | Refreshed |
|---|---|---|---|
| PROVISIONING (header) | `project_environments.status`, read at `lib/rpc/procedures/clusters.ts:127`. `deriveHealth` gives an in-flight environment status priority over everything else (`components/clusters/cluster-card.tsx:90`) | `set_env_status` CAS (`lib/db/env-status.ts:57` `deployStart`, called from `app/api/jobs/[id]/status/route.ts:327` when a DEPLOY reports PROCESSING) | Only by another lifecycle callback or the convergence backstop |
| Control plane AKS ACTIVE | `project_cluster.status` (`clusters.ts:136`, rendered raw at `cluster-card.tsx:281`) | `finalizeDeployment` on DEPLOY SUCCESS sets `ACTIVE` (`lib/jobs/finalize-deployment.ts:291`). A successful DESTROY sets `DESTROYED` (`:243`) | **Never.** Nothing else writes the column: no probe, no drift scan, and no timer |
| "1 / 1 healthy" | Count of `statusTier(...) === "active"` over the cluster row and its data services (`cluster-card.tsx:81-87`) | Same as above | Never |
| kubeconfig command + download | `readKubeconfigAccess` (`clusters.ts:208-219`, `:238`). The download is refused only for DRAFT/DESTROYING/DESTROYED environments (`lib/clusters/mint-eligibility.ts`) | n/a | n/a. Nothing consulted drift or probes |

So "ACTIVE" on the card meant "the last successful deploy said so". That deploy ran four months
earlier, and the card did not show its date.

The two signals that could have said more both exist, and neither fed the card:

- **Liveness probes** (`environment_probes`). These are scheduled only for environments whose
  status is ACTIVE (`lib/probes/dispatch.ts:84`). An environment stuck in PROVISIONING is never
  probed, so a stuck environment loses its only liveness signal.
- **Drift scans** (`environment_drift`). These are scheduled for every environment with a
  successful DEPLOY, whatever its status. That is why weekly "Detect Drift" jobs kept succeeding.
  `recordDriftPosture` (`lib/drift/posture.ts:23-53`) upserts `in_sync`, `drifted`, `details` and
  `scanned_at`, and writes nothing else. No reader of `environment_drift` writes an environment or
  cluster status. The only places a deletion appears are the evidence page and the canvas drift map.

### The environment card (`/[org]/a640/environments`)

| What it showed | Source |
|---|---|
| "Deploying" | **Not the environment's status.** `components/environments/environment-card.tsx:111` rendered `deployPending ? "Deploying" : "Live"`. `deployPending` is `structuralHash(design) !== deployed_config_hash` (`app/server/actions/reconcile.ts:122`), which means "the design moved ahead of the last deploy". So an environment with an undeployed edit and no job read as Deploying for as long as the edit stayed undeployed. `EnvRow` did not even carry `status`. |
| "Drifted" | `environment_drift.in_sync === false` for the latest scan (`reconcile.ts:108`) |
| "Updated 4 months ago" | `project_environments.updated_at`, which `set_env_status` stamps on every transition (`lib/db/programmables.sql:2927`). The environment's status therefore last changed four months ago. |
| "In sync" (other environments) | Shown whenever `driftInSync !== false` (`environment-card.tsx:134`), including `null`, which means never scanned. That contradicts the evidence page's "Not scanned". |

The two cards agree on the stored status. The cluster card shows PROVISIONING and the environment
card shows "Deploying" from a different field. Both describe an environment whose status has not
moved for four months.

## 2. Why the environment never left PROVISIONING

Two mechanisms are supposed to move an environment out of an in-flight status:

1. **The runner's status callback.** It runs when the DEPLOY job goes SUCCESS or FAILED (`route.ts`).
2. **`recover_stale_jobs`** (`programmables.sql:846-905`), every 60s. It handles only
   `j.status IN ('CLAIMED', 'PROCESSING')` (`:889`). A dead or stalled job is **requeued to
   QUEUED** below the attempt cap, and "requeued ones keep their env". Only a job failed terminally
   moves its environment to FAILED (`lib/jobs/recovery.ts:80-109`).
3. **The convergence backstop** (`lib/reconcile/converge.ts`). It settles an environment stuck in
   QUEUED/PROVISIONING/DESTROYING only when its newest lifecycle job is **terminal** (`:119`), has a
   `completed_at` (`:123`), and no lifecycle job is still QUEUED, CLAIMED or PROCESSING (`:125`).

Nothing sweeps a **QUEUED** job. Several sequences end with a terminal-less lifecycle that every
sweeper skips:

- The DEPLOY reached PROCESSING, so the environment went to PROVISIONING. Its runner then died
  before the apply started, and `recover_stale_jobs` requeued the job to QUEUED. If no runner ever
  claimed it again, the job waits forever. The environment stays PROVISIONING, and convergence
  skips it because a lifecycle job is still "in flight" (`NOT EXISTS`, `:125`).
- A job is enqueued and never claimed (no runner online for that cloud). The same outcome, from
  QUEUED.
- An environment in flight has no lifecycle job at all. The LATERAL in `findCandidates` then yields
  no row, so the environment is never a candidate.

The Plan job on another project that was "cancelled" after 120 days fits the first two sequences. It
was a QUEUED job that nothing expired, until someone cancelled it. Whether a640's environment is
stuck behind a QUEUED job or has no job at all needs one read of production `jobs` for that
`environment_id`. The fix covers both.

## 3. Root cause of the contradiction

Each surface repeats a value written at a different moment, and none says when:

- The control plane status is a **write-once record of the last successful deploy**, presented as
  current.
- The environment status is a **lifecycle that can be stranded**, because no sweeper covers an
  unclaimed job or a jobless in-flight environment.
- The drift scan is the only fresh observation. It is **not read by any status surface**, and it
  never writes back.
- Stranding the environment in PROVISIONING also **switched off the liveness probe**. That left the
  drift scan as the only observation of the cluster.

## 4. What changed

- **`lib/clusters/observed-state.ts`** (new, pure) derives what may be claimed about a control plane
  from the last deploy, the latest drift scan and the latest probe:
  - `missing`: a drift scan taken since the deploy reports the cluster resource deleted, or the
    Azure resource group holding it.
  - `unreachable`: a probe taken since the deploy failed to reach the cluster.
  - `reported`: neither of the above. The result also records when the newest supporting reading
    was taken, and whether that reading is still fresh (two probe intervals for the tier).
- **Clusters read** (`lib/rpc/procedures/clusters.ts`, plus `lib/clusters/observed-evidence.ts`)
  attaches `project_cluster.observation` and `status_since`. A `missing` cluster gets no kubeconfig
  command, no cloud-CLI command and no download. A note explains why.
- **Cluster card**:
  - The control plane reads Missing, Unreachable or Unverified instead of a stale ACTIVE.
  - A stale or missing control plane is never counted as healthy.
  - The header reads Missing unless a run started after the scan.
  - A new line says when the status was last observed and by what. It also says since when a run
    has been in flight.
  - The skeleton draws the new line, so the page does not shift when the cards load.
- **Environment card**:
  - The badge comes from `project_environments.status`.
  - Undeployed design changes get their own "Undeployed changes" chip.
  - "Cluster missing", with the deleted addresses, replaces "Drifted" when it applies.
  - "Not scanned for drift" replaces a false "In sync".
- **Convergence backstop** (`lib/reconcile/converge.ts`):
  - A DEPLOY/DESTROY/PLAN job that has sat QUEUED for more than `UNCLAIMED_JOB_TTL_HOURS` (default
    24, env `ALETHIA_UNCLAIMED_JOB_TTL_HOURS`) **while its environment is stuck in flight** is
    cancelled. The cancel records the stated reason, the same way a user cancel does, and emits
    `system.job.cancelled`. Ordinary convergence then settles the environment: a DEPLOY or DESTROY
    to FAILED, a PLAN to DRAFT.
  - An environment stuck in flight past the same TTL with no lifecycle job at all is settled FAILED.
  - A terminal job with no `completed_at` falls back to its `updated_at` for the staleness gate.

## 5. Left for a product decision

- **Auto-marking an environment or cluster DESTROYED when drift reports it deleted.** Not done. A
  refresh-only plan can report a deletion that a credential or permission problem produced, and
  DESTROYED stops the drift scans, the probes and the cluster count. The surfaces now say "Missing"
  and withhold credentials, and nothing is written.
- **The TTL values**: 24h for an unclaimed lifecycle job, and the freshness window of two probe
  intervals (20m prod, 2h staging, 12h dev).
- **Probing environments that are not ACTIVE.** `lib/probes/dispatch.ts` deliberately probes only
  ACTIVE environments.
- **`alethia cluster get` / `GET /api/cli/clusters`** still print the kubeconfig command for a missing
  cluster. They build it in the same module, but they do not read the observation yet.
- **A promotion whose deploy job is cancelled this way** stays DEPLOYING. This was already true of a
  job a user cancels.
- **A PROCESSING job whose runner is alive but has a NULL `progress_at`** matches neither recovery
  rule in `recover_stale_jobs`. That fix is a change to `programmables.sql` and is not made here.
