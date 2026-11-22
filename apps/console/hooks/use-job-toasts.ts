"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useRecentJobsQuery } from "@/lib/query/use-jobs-query";
import type { ShellJob } from "@/lib/rpc/procedures/workspace";
import type { ProvisionJobStatus } from "@/lib/db/schema";
import { track } from "@/lib/analytics/track";
import { NOTIFY_JOB_TYPES, jobPhase, jobToastContent } from "@/lib/jobs/toast-copy";

/**
 * The single job-lifecycle toast driver. Mount it exactly once (via `<JobToaster />` in the
 * app shell) — it owns ONLY the toast side-effect, decoupled from the notifications bell.
 *
 * Each job gets ONE toast keyed by a stable sonner id (`job-<id>`): `toast.loading` while it
 * runs, then `toast.success`/`error`/neutral on the same id when it finishes, so the toast
 * morphs in place rather than stacking. The stable id also makes re-emits idempotent (sonner
 * updates the existing toast), which is the whole dedup mechanism.
 *
 * Jobs already present in the first settled snapshot are treated as pre-existing and never
 * toasted — toasts are for work that starts in THIS session; history lives on the Jobs
 * page and the bell.
 *
 * THE FEED IS THE ORG'S NEWEST JOBS, CAPPED (`SHELL_JOB_FEED_LIMIT`), so a job this hook is
 * showing as in flight can leave it before it finishes — pushed out by newer jobs. Its toast is
 * then dismissed: with no later snapshot to carry its outcome, a spinner left up would never
 * resolve. The outcome is on the Jobs page and in the bell.
 *
 * NOT YET FILTERED BY AUTHOR: the feed's rows (`ShellJob`, lib/rpc/procedures/workspace.ts) do not
 * carry who started the job, so a teammate's deploy toasts here too. That needs `user_id` on the
 * feed, which is outside this hook.
 */
export function useJobToasts(): void {
	const { data: jobs } = useRecentJobsQuery();
	const router = useRouter();
	const { org } = useParams<{ org: string }>();

	// Ids present in the first settled snapshot — pre-existing work, never toasted.
	const knownRef = useRef<Set<string>>(new Set());
	// Last status we emitted a toast for, per managed job — guards against re-emitting an
	// unchanged status every time the feed is read again (a `jobs` hint, a refocus).
	const statusRef = useRef<Map<string, ProvisionJobStatus>>(new Map());
	const seededRef = useRef(false);
	// Keep the live org in a ref so a "View job" closure created on one page still navigates
	// correctly after the user moves to another (the shell, and this hook, stay mounted).
	const orgRef = useRef(org);
	useEffect(() => {
		orgRef.current = org;
	}, [org]);

	useEffect(() => {
		// `undefined` = query not settled yet; wait for the first real fetch (including `[]`).
		if (jobs === undefined) return;

		// Seed the baseline from the first settled snapshot (even an empty one — so the
		// genuinely-first job of a session still toasts) and emit nothing.
		if (!seededRef.current) {
			for (const job of jobs) knownRef.current.add(job.id);
			seededRef.current = true;
			return;
		}

		for (const job of jobs) {
			if (knownRef.current.has(job.id)) continue;
			if (!NOTIFY_JOB_TYPES.has(job.job_type)) continue;
			if (statusRef.current.get(job.id) === job.status) continue;
			statusRef.current.set(job.id, job.status);
			emit(job);
		}

		// A job last shown as in flight that is no longer in the feed: nothing will ever arrive to
		// resolve its toast, so take it down. A finished job's toast is left to its own duration.
		const inFeed = new Set(jobs.map((job) => job.id));
		for (const [jobId, status] of statusRef.current) {
			if (inFeed.has(jobId) || jobPhase(status) !== "active") continue;
			toast.dismiss(`job-${jobId}`);
			statusRef.current.delete(jobId);
			// Remembered as seen, so it is not toasted afresh if it comes back into the feed.
			knownRef.current.add(jobId);
		}

		/** Renders/updates the single toast for a job at its current phase. */
		function emit(job: ShellJob): void {
			const id = `job-${job.id}`;
			const phase = jobPhase(job.status);
			const { title, description } = jobToastContent(job, phase);
			const action = {
				label: "View job",
				onClick: () => router.push(`/${orgRef.current}/~/jobs/${job.id}`),
			};

			switch (phase) {
				case "active":
					toast.loading(title, { id, description, action });
					break;
				case "success":
					toast.success(title, { id, description, action, duration: 6000 });
					// The value moment: a project deploy actually succeeded (vs. `deploy_queued` = intent).
					if (job.job_type === "DEPLOY") {
						track("deploy_succeeded", {
							jobId: job.id,
							provider: job.cloud_provider,
							stage: job.environment_stage,
						});
					}
					break;
				case "failed":
					toast.error(title, { id, description, action, duration: 10000 });
					if (job.job_type === "DEPLOY") {
						track("deploy_failed", {
							jobId: job.id,
							provider: job.cloud_provider,
							stage: job.environment_stage,
						});
					}
					break;
				case "cancelled":
					toast(title, { id, description });
					break;
			}
		}
	}, [jobs, router]);
}
