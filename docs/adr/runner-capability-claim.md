<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# A runner claims only the jobs it can run, and a job no live runner can run fails

**Status:** Accepted · **Issue:** #6458 · **Follows:** #6454 (`X-Runner-Capabilities`, `refusalForRunner`),
[byo-oci-hardened-path.md](byo-oci-hardened-path.md)

## Property

A runner is handed only a job whose required capabilities it advertises, as long as a live runner in
the job's pool advertises them. In a mixed pool during a rollout, an old runner never fails a job that
a newer runner in the same pool could run, however long other gates hold the job. When no live runner
in the pool can run the job, it fails at the next claim, with the same "update the runner" reason as
before. It does not wait in the queue forever.

## Decision

1. **A job's requirements are stored, and derived in SQL.** `public.job_required_capabilities(job_type,
   config_snapshot)` (`apps/console/lib/db/programmables.sql`) returns `{addon-byo-marker}` for a
   DEPLOY whose snapshot holds an OCI bring-your-own chart. An OCI BYO chart is an add-on with
   `byo: true` whose `source` is not `"git"`. For any other job, the function returns `{}`. The
   function is the SQL half of `refusalForRunner` (`apps/console/lib/runners/snapshot-capabilities.ts`).
   A trigger (`jobs_set_required_capabilities`, on INSERT and on any change to `job_type`,
   `config_snapshot` or the column itself) stores the result in `jobs.required_capabilities`. No
   enqueue site writes the column, so none can forget it, a direct write is re-derived, and the claim compares two arrays instead of reading every
   candidate's snapshot. `programmables.sql` backfills the rows that can still be claimed. The SQL and
   TypeScript halves are pinned to each other over the shared fixtures in
   `packages/core/types/testdata/snapshot-capabilities` and a set of edge shapes, by
   `apps/console/tests/integration/claim-capability-skip.test.ts`.

2. **A runner's capabilities are stored, stamped on every claim and heartbeat.** Both routes parse
   `X-Runner-Capabilities`. `claim_next_job` and `runner_heartbeat` each take a new defaulted
   `p_capabilities TEXT[]` argument and write it to `runners.capabilities`. A runner that sends no
   header stamps `{}`. `claim_next_job` also stamps `runners.last_claim_at` on every poll.

   **`NULL` means "this caller does not know", not "no capabilities".** It is what a console pod on the
   previous release passes, both mid-rollout and indefinitely after a console rollback, since the
   database stays forward. Such a call keeps the last stamp and gets **no capability gate** in the
   claim. That is the pre-#6458 behaviour, and the old pod's own post-claim `refusalForRunner` is the
   check. Reading `NULL` as "none" would let a stamped capable runner, claiming through an old pod,
   skip its own job, and every runner would skip it for as long as that runner lived. The heartbeat matters because a runner busy with a long apply makes no
   claims but still heartbeats, so it remains known to be capable. The old function forms are dropped
   first, so that no ambiguous overload is left behind.

3. **The skip is bounded by presence, not by time.** In both unassigned branches (the managed pool and a
   self runner's own org), a runner skips a job whose `required_capabilities` it lacks while
   `live_runner_has_capabilities` finds a **live** runner in the job's pool that has them. The job
   stays QUEUED, and `ORDER BY … LIMIT 1` moves on. Once no such runner exists, nobody else could run
   the job. The incapable runner is then handed it, and `refusalForRunner` fails it through
   `recordJobFailed`. The job, the environment, a promotion and the `system.job.failed` alert end
   exactly as for any other claim-time refusal.
   - *The pool* is the set of runners that `claim_next_job` would let take the job, assignment aside:
     a managed runner (unless the job requires a self runner), or a self runner of the job's org. Both
     pass the claim's own cloud-identity and provider filters, read off the runner row.
   - *Live* means `ONLINE`, which excludes DRAINING and OFFLINE, with a heartbeat inside
     `runner_liveness_window()` (5 minutes). That is the one definition of the window, and
     `recover_stale_jobs` reads it too. It also means *claiming*: the runner called the claim inside
     that window (an idle runner polls at least every 30 s), or it holds an in-flight job (served by
     the partial index `idx_jobs_runner_inflight`). So a runner whose heartbeat loop runs while its
     claim loop is wedged stops holding the job once the window passes. For the same reason, a runner
     whose claim poll is slower than the window stops counting as capable while it is idle.
   - `live_runner_has_capabilities` is not `SECURITY DEFINER`, and `EXECUTE` is revoked from `PUBLIC`.
     It answers a cross-tenant question, so only `claim_next_job` (a definer) may ask it.

   *Why not a time bound:* the first version of this change failed the job once it had been QUEUED for
   15 minutes. That clock kept running while `state_object_busy`, `destroy_waits_on_tenants` or the
   managed concurrency cap held the job. So after a long apply on the same environment, an old runner
   could win the wake race and fail a job that an idle capable runner was about to take. Presence asks
   the question the property is about: "could anyone else run this?"

4. **An assigned job is not skipped.** No other runner may claim a job assigned to a runner, so
   skipping it would only delay the same answer. `refusalForRunner` fails it at once.

5. **`refusalForRunner` stays.** It turns "no live capable runner" into a failure, it handles the
   assigned case, and it is the defence should the SQL and TypeScript readings of a snapshot ever
   disagree.

## Consequences

- A job is failed by an incapable runner only when no live runner in its pool advertises the
  capability, at the moment of that runner's claim. A capable runner that is busy but heartbeating
  still counts, so the job waits for it.
- A capable runner that dies without a clean disconnect keeps counting until its heartbeat ages out
  of the liveness window. Until then, the job waits rather than fails. The same window applies to a
  runner that heartbeats without claiming, unless it holds an in-flight job, in which case
  `recover_stale_jobs` handles a stall.
- While any console pod on the previous release remains, its claims run without the gate and can
  still fail a job that a capable runner could run, as before #6458. That window ends when the
  rollout does.
- A pool with no runner polling at all still waits, as it does for every job type.
- **The wait is not surfaced.** While it is skipped, the job reads QUEUED with no reason. There is no
  per-job "waiting because" surface to extend today: the job page shows a generic "Waiting for runner
  to claim job". Adding a reason is a UI change, and is left to a `class:ui` follow-up rather than
  folded into this one.
- The fleet's dispatchable backlog is unchanged: a skipped job is still work that a capable runner can
  take.
