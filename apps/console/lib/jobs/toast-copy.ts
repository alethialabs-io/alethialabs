// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Copy + classification for the job lifecycle toast (hooks/use-job-toasts.ts). Pure, no
// React, so the driver stays thin and this stays unit-testable. Labels reuse the job-type
// catalog in ./format so the wording never drifts from the jobs table / overview card.

import type { JobWithMeta } from "@/app/server/actions/jobs";
import type { ProvisionJobStatus, ProvisionJobType } from "@/lib/db/schema";
import { JOB_TYPES } from "./format";

/**
 * Job types that deserve a live toast — user-initiated, foreground work. Internal/background
 * types (ANALYZE_REPO / DETECT_DRIFT run unattended) would only spam the user, so they're excluded.
 * (Connection verification is server-side now — instant, no job — so it never toasts.)
 */
export const NOTIFY_JOB_TYPES: ReadonlySet<ProvisionJobType> = new Set([
	"DEPLOY",
	"DESTROY",
	"PLAN",
	"DEPLOY_RUNNER",
	"UPDATE_RUNNER",
	"DESTROY_RUNNER",
]);

/** The visual phase a toast is in, collapsing the six job statuses to four outcomes. */
export type ToastPhase = "active" | "success" | "failed" | "cancelled";

/** Maps a job status to its toast phase (QUEUED/CLAIMED/PROCESSING all read as "active"). */
export function jobPhase(status: ProvisionJobStatus): ToastPhase {
	switch (status) {
		case "SUCCESS":
			return "success";
		case "FAILED":
			return "failed";
		case "CANCELLED":
			return "cancelled";
		default:
			return "active";
	}
}

/** Present-progressive verb per job type, for the in-flight ("active") toast title. */
const GERUND: Partial<Record<ProvisionJobType, string>> = {
	DEPLOY: "Deploying",
	DESTROY: "Destroying",
	PLAN: "Planning",
	DEPLOY_RUNNER: "Deploying runner",
	UPDATE_RUNNER: "Updating runner",
	DESTROY_RUNNER: "Destroying runner",
};

/** Builds the title + optional description for a job's toast in a given phase. */
export function jobToastContent(
	job: JobWithMeta,
	phase: ToastPhase,
): { title: string; description?: string } {
	const label = JOB_TYPES[job.job_type]?.label ?? job.job_type;
	// "project · environment" when both are joined; either alone is fine; undefined if neither.
	const scope =
		[job.project_name, job.environment_name].filter(Boolean).join(" · ") ||
		undefined;

	switch (phase) {
		case "active":
			return { title: `${GERUND[job.job_type] ?? label}…`, description: scope };
		case "success":
			return { title: `${label} complete`, description: scope };
		case "failed":
			return {
				title: `${label} failed`,
				description: job.error_message?.slice(0, 140) ?? scope,
			};
		case "cancelled":
			return { title: `${label} cancelled`, description: scope };
	}
}
