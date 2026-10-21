// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// JOB VISIBILITY FOLLOWS PROJECT VISIBILITY. A job is visible to a reader exactly when its project
// is: a reader who may view project P sees P's jobs, and a reader who may not (no grant, or an
// explicit deny on P) sees none of them. A job with no project (an org-level job, or one whose
// project was deleted) is org-wide and follows the org's own job permission.
//
// The project set is the PDP's own answer (`listAccessible(actor, "view", "project")`), so both
// engines (community Postgres RBAC, enterprise OpenFGA) decide it, deny-aware, in one place.
//
// WHICH READERS APPLY IT — named, because "every" is a claim the next reader relies on:
//   · the console's jobs read procedures (lib/rpc/procedures/jobs.ts): the list page's rows, facet
//     counts and total; one job; its status; its plan result; its log head; one project's jobs;
//   · the shell's job feeds (lib/rpc/procedures/workspace.ts): the capped `workspace.recentJobs`
//     (the bell, toasts, breadcrumbs, the command palette, the overview's recent jobs) and the full
//     `workspace.jobs` (`getJobs`, also the assistant's `list_jobs` and mentions); the assistant's
//     `get_job` and `get_plan_result` read through the procedures' readers;
//   · the console's re-run, cancel and apply (app/server/actions/jobs.ts);
//   · the per-job log stream (app/api/stream/jobs/[id]);
//   · the CLI: `GET /api/jobs`, `GET /api/cli/jobs/[id]`, `GET /api/cli/jobs/[id]/logs` and
//     `POST /api/cli/jobs/[id]/cancel`.
// The cancel both surfaces share (lib/jobs/cancel.ts) reads through the same predicate.
// Reads that are NOT on this list do not apply it. Adding a jobs read means adding it here.
//
// The rule reads `jobs.project_id`. Every job of a project carries it — a project's scans too, since
// #6121. A scan enqueued before that carried its project only in its snapshot
// (`config_snapshot.project_id`): programmables.sql backfills the column for those, and until every
// deployment has run that backfill the predicate below ALSO reads the snapshot for a scan whose
// column is empty, so a scan is never org-wide — the same project `projectOf` (lib/jobs/operation.ts)
// resolves for its cancel.

import "server-only";

import { and, inArray, isNull, notInArray, or, type SQL, sql } from "drizzle-orm";
import { cache } from "react";
import { getPdp } from "@/lib/authz";
import type { Actor } from "@/lib/authz/types";
import { jobs } from "@/lib/db/schema";
import { isScan, type JobTarget, projectOf, SCAN_KINDS } from "@/lib/jobs/operation";

/**
 * The PDP's answer for one (user, org), memoized for the duration of ONE server render: a page that
 * reads a job, its log head and its list asks once, not three times. `cache()` is per request — it
 * is a pass-through outside a React server render (route handlers, actions), where each call asks —
 * so no answer outlives the request that asked it, and a changed grant is read on the next one.
 */
const viewableFor = cache(
	(userId: string, orgId: string): Promise<string[]> => getPdp().listAccessible({ userId, orgId }, "view", "project"),
);

/** The ids of the projects `actor` may view — the set job visibility follows. */
export async function viewableProjectIds(actor: Actor): Promise<string[]> {
	return viewableFor(actor.userId, actor.orgId);
}

/**
 * The predicate on `jobs` for a reader who may view exactly `projectIds`:
 *   · the job's project is one of them; or
 *   · it has no project and is not a scan (an org-level job, or one whose project was deleted); or
 *   · it is a scan with no project in the column whose SNAPSHOT names one of them (a scan enqueued
 *     before scans carried the column — see the header). A scan naming no project anywhere is hidden.
 */
export function jobVisibleWhere(projectIds: readonly string[]): SQL {
	const scans = [...SCAN_KINDS];
	const orgWide = and(isNull(jobs.project_id), notInArray(jobs.job_type, scans)) ?? sql`false`;
	if (projectIds.length === 0) return orgWide;
	const ids = [...projectIds];
	const legacyScan = and(
		isNull(jobs.project_id),
		inArray(jobs.job_type, scans),
		inArray(sql`${jobs.config_snapshot}->>'project_id'`, ids),
	);
	return or(orgWide, inArray(jobs.project_id, ids), legacyScan) ?? orgWide;
}

/** The predicate on `jobs` for `actor`: {@link jobVisibleWhere} over the projects they may view. */
export async function jobVisibleTo(actor: Actor): Promise<SQL> {
	return jobVisibleWhere(await viewableProjectIds(actor));
}

/**
 * Whether `job` is visible to `actor` — for a read that already holds the row. The same rule as
 * {@link jobVisibleWhere}: the job's project (its column, or for a scan its snapshot — `projectOf`)
 * must be one the actor may view; a job with no project is org-wide, except a scan naming none.
 */
export async function isJobVisible(actor: Actor, job: JobTarget): Promise<boolean> {
	const projectId = projectOf(job);
	if (projectId === null) return !isScan(job.job_type);
	return (await viewableProjectIds(actor)).includes(projectId);
}
