<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# A runner claims only the jobs it can run, and a job no runner can run fails within a bound

**Status:** Accepted · **Issue:** #6458 · **Follows:** #6454 (`X-Runner-Capabilities`, `refusalForRunner`),
[byo-oci-hardened-path.md](byo-oci-hardened-path.md)

## Property

A runner is handed only a job whose required capabilities it advertises. In a mixed pool during a
runner rollout, an old runner never fails a job that a newer runner in the same pool could run. A job
that no runner in its pool can run does not wait in the queue forever: it fails within a bounded time,
with the same "update the runner" reason as before.

## Decision

1. **Requirements are computed from the stored snapshot, in SQL, at claim time.**
   `public.job_required_capabilities(job_type, config_snapshot)` (`apps/console/lib/db/programmables.sql`)
   returns `{addon-byo-marker}` for a DEPLOY whose snapshot holds an OCI bring-your-own chart (an add-on
   with `byo: true` whose `source` is not `"git"`), and `{}` for everything else. It is the SQL half of
   `refusalForRunner` (`apps/console/lib/runners/snapshot-capabilities.ts`). There is no new column, so
   there is no migration and no backfill, and a row enqueued before this change is judged like a new one.
   The two halves are pinned to each other over the shared fixtures in
   `packages/core/types/testdata/snapshot-capabilities` and a set of edge shapes by
   `apps/console/tests/integration/claim-capability-skip.test.ts`.

2. **The runner's capabilities go into the claim.** The claim route parses `X-Runner-Capabilities` and
   passes it to `claim_next_job` as a new `p_capabilities TEXT[] DEFAULT NULL` argument (`NULL` means
   none). The old 3-argument function is dropped first, because adding a defaulted argument next to it
   would leave two overloads and make every 3-argument call ambiguous. Both unassigned branches (the
   managed pool and a self runner's own org) skip a job whose requirements the runner lacks, so the job
   stays QUEUED and `ORDER BY … LIMIT 1` moves on to the next one.

3. **The wait is bounded by time, and the bound lives in the claim (option ii).** The skip applies only
   while the job has been QUEUED for less than `public.capability_wait_bound()` (15 minutes), measured
   from its `updated_at` so a job requeued by recovery gets a fresh window. After that, an incapable
   runner is handed the job, and `refusalForRunner` fails it through `recordJobFailed` with the
   "update the runner" reason: the job, the environment, a promotion and the `system.job.failed` alert
   end exactly as they did before the skip existed.

   *Why not refuse at enqueue (option i):* runners advertise capabilities per request and nothing stores
   them, so "is a capable runner registered in this pool?" cannot be answered at enqueue without new
   state on `runners`. A time bound needs none, and it reuses the one failure path every other claim-time
   refusal already goes through.

4. **An assigned job is not skipped.** No other runner may claim a job assigned to a runner, so
   skipping it would only delay the same answer. `refusalForRunner` fails it at once.

5. **`refusalForRunner` stays.** It is what turns the bounded wait into a failure, it handles the
   assigned case, and it is the defence should the SQL and TypeScript readings of a snapshot ever
   disagree.

## Consequences

- A capable runner that stays busy for longer than the bound while an incapable runner polls loses the
  job to a failure the user redeploys past. That is the same outcome as before this change, now limited
  to a pool where the capable runners are saturated for 15 minutes.
- A pool with no runner polling at all still waits, as it does for every job type.
- The fleet's dispatchable backlog is unchanged: a skipped job is still work a capable runner can take.
