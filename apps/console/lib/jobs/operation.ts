// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// WHAT A JOB IS AN OPERATION OF, AND HOW IT MAY BE RUN AGAIN OR STOPPED (#6121).
//
// A job is an operation ON SOMETHING: a project's plan, deploy or destroy; a runner's deploy,
// update or destroy; a project's scan, build, drift check or probe. Acting on the job is acting on
// that thing, so:
//
//   · RE-RUNNING a project's plan, deploy or destroy runs the operation again through the entry
//     point a fresh run uses (the project permission for it, the environment's one-job-in-flight
//     guard, the queue-time gates, the project's CURRENT configuration). Every other kind of job is
//     run again from where it was started — the runner, the project — and is refused here with a
//     sentence that says so. The one exception is an explicit ALLOW-LIST of job kinds whose copy
//     acts on nothing but its own input ({@link COPYABLE}): those are re-queued as a copy under the
//     org's job permission. A job is copyable because of its KIND, never because a column happens
//     to be empty: a runner's lifecycle job and a project's scan carry their target in the config
//     snapshot, not in `project_id`.
//   · CANCELLING a job takes the permission its operation takes on its target
//     ({@link permissionToCancel}), as well as `edit` on the job.
//
// Pure (no DB, no React): the console's re-run and cancel, the CLI's cancel and the break-glass
// retry read the same answers from here.

import type { ProvisionJobType } from "@/lib/db/schema";

/** A project operation a job can be an instance of — the project permission acting on it takes. */
export type ProjectOperation = "plan" | "deploy" | "destroy";

/** How a job may be run again. */
export type RerunRoute =
	/** A project's plan, deploy or destroy: run the operation again through its own entry point. */
	| { kind: "project"; operation: ProjectOperation; projectId: string; environmentId: string | null }
	/** A job of an allow-listed kind: re-queue a copy of it. */
	| { kind: "copy" }
	/** Not re-runnable from the job. `reason` is shown to the user as written. */
	| { kind: "refuse"; reason: string };

/** The sentence for a job that is run again from its project. */
export const RERUN_FROM_PROJECT = "This job can't be re-run from here. Run it again from the project.";
/** The sentence for a runner's lifecycle job. */
export const RERUN_FROM_RUNNER = "This job can't be re-run from here. Run it again from the runner.";
/** The sentence for any other job that is run again where it was started. */
export const RERUN_FROM_ORIGIN = "This job can't be re-run from here. Run it again from where it was started.";

/**
 * The job kinds a re-run may COPY: a copy of one acts on nothing but its own input, takes no
 * permission beyond creating a job, and charges nothing a fresh run would charge differently.
 * Only an org-level AUDIT, today. Adding a kind here is a decision about what its copy can touch.
 */
const COPYABLE: ReadonlySet<ProvisionJobType> = new Set<ProvisionJobType>(["AUDIT"]);

/** The runner lifecycle kinds, and the permission each takes on its runner. */
const RUNNER_LIFECYCLE = {
	DEPLOY_RUNNER: "deploy",
	UPDATE_RUNNER: "edit",
	DESTROY_RUNNER: "destroy",
} as const satisfies Partial<Record<ProvisionJobType, string>>;

/** Whether `jobType` is one of a runner's lifecycle jobs. */
export function isRunnerLifecycle(jobType: ProvisionJobType): jobType is keyof typeof RUNNER_LIFECYCLE {
	return jobType in RUNNER_LIFECYCLE;
}

/** The project operation a job of `jobType` performs, or null when it is none of the three. */
export function operationOf(jobType: ProvisionJobType): ProjectOperation | null {
	switch (jobType) {
		case "PLAN":
			return "plan";
		case "DEPLOY":
			return "deploy";
		case "DESTROY":
			return "destroy";
		default:
			return null;
	}
}

/** The fields of a job these rules read. */
export interface JobTarget {
	job_type: ProvisionJobType;
	project_id: string | null;
	environment_id: string | null;
	config_snapshot?: Record<string, unknown> | null;
}

/**
 * The scan kinds: they act on a project's source, recorded on the project they scan. A scan
 * enqueued before #6121 carries that project only in its snapshot (`config_snapshot.project_id`).
 */
export const SCAN_KINDS = ["IAC_SCAN", "CHART_SCAN"] as const satisfies readonly ProvisionJobType[];

/** Whether `jobType` is a scan kind. */
export function isScan(jobType: ProvisionJobType): boolean {
	return jobType === "IAC_SCAN" || jobType === "CHART_SCAN";
}

/**
 * The project a job acts on: its `project_id`, or — for a scan stored before scans carried the
 * column — the project its snapshot names. Null when it acts on no project.
 */
export function projectOf(job: Pick<JobTarget, "job_type" | "project_id" | "config_snapshot">): string | null {
	if (job.project_id !== null) return job.project_id;
	if (!isScan(job.job_type)) return null;
	const id = job.config_snapshot?.project_id;
	return typeof id === "string" && id.length > 0 ? id : null;
}

/** The runner a runner lifecycle job acts on (its snapshot's `runner_id`), or null. */
export function runnerOf(job: Pick<JobTarget, "config_snapshot">): string | null {
	const id = job.config_snapshot?.runner_id;
	return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * The permission cancelling a job takes on its target, beyond the org-level `edit` on the job
 * that every cancel takes first:
 *   · a runner's lifecycle job: the runner permission its operation takes (deploy / edit / destroy);
 *   · a project's scan: `edit` on the project, the permission a fresh scan takes;
 *   · any other job of a project: the project operation's own permission, and `deploy` for the rest
 *     (a build, a drift check, a probe: part of keeping the deployment running).
 *
 * `null` — no target permission; the org-level `edit` on the job is the whole check — for a job with
 * no target: an org-level job (an AUDIT, a repository analysis), AND a job whose project has been
 * DELETED. Deleting a project sets its jobs' `project_id` to null, and there is no project left to
 * ask about; an in-flight job of a deleted project stays stoppable by whoever may edit the org's jobs.
 *
 * A target that EXISTS but cannot be named is refused instead (`id: null`; the caller answers
 * "no-target"): a runner job whose snapshot names no runner, a scan whose snapshot names no project.
 */
export type CancelPermission =
	| { type: "runner"; action: "deploy" | "edit" | "destroy"; id: string | null }
	| { type: "project"; action: ProjectOperation | "edit"; id: string | null }
	| null;

/** See {@link CancelPermission}. */
export function permissionToCancel(job: JobTarget): CancelPermission {
	if (isRunnerLifecycle(job.job_type)) {
		return { type: "runner", action: RUNNER_LIFECYCLE[job.job_type], id: runnerOf(job) };
	}
	const projectId = projectOf(job);
	if (projectId !== null) {
		return {
			type: "project",
			action: isScan(job.job_type) ? "edit" : (operationOf(job.job_type) ?? "deploy"),
			id: projectId,
		};
	}
	// A scan is always a project's: one whose project cannot be named has no nameable target.
	if (isScan(job.job_type)) return { type: "project", action: "edit", id: null };
	return null;
}

/** How a job may be run again (see the header). */
export function rerunRouteOf(job: JobTarget): RerunRoute {
	if (isRunnerLifecycle(job.job_type)) return { kind: "refuse", reason: RERUN_FROM_RUNNER };
	const operation = operationOf(job.job_type);
	if (operation !== null && job.project_id !== null) {
		return { kind: "project", operation, projectId: job.project_id, environmentId: job.environment_id };
	}
	if (COPYABLE.has(job.job_type) && job.project_id === null && job.environment_id === null) {
		return { kind: "copy" };
	}
	return {
		kind: "refuse",
		reason: job.project_id !== null || operation !== null || isProjectKind(job.job_type) ? RERUN_FROM_PROJECT : RERUN_FROM_ORIGIN,
	};
}

/** Kinds that are always a project's, even when the project sits in the snapshot. */
function isProjectKind(jobType: ProvisionJobType): boolean {
	return (
		jobType === "IAC_SCAN" ||
		jobType === "CHART_SCAN" ||
		jobType === "DETECT_DRIFT" ||
		jobType === "BUILD" ||
		jobType === "PROBE_CLUSTER" ||
		jobType === "STATE_SURGERY" ||
		jobType === "MINT_KUBECONFIG" ||
		jobType === "AUDIT"
	);
}
