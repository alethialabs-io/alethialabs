// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A job is an operation ON SOMETHING (#6121, lib/jobs/operation.ts): re-running it runs the operation
// again through its own entry point or is refused with where to do it, only an allow-listed kind is
// copied, and stopping it takes the permission its operation takes on its target.
//
// THE TABLES ARE KEYED BY EVERY JOB KIND (`Record<ProvisionJobType, …>`), so a new kind in the enum
// fails to compile here until someone decides how it is re-run and who may stop it.

import { describe, expect, it } from "vitest";
import type { ProvisionJobType } from "@/lib/db/schema";
import { provisionJobType } from "@/lib/db/schema/enums";
import {
	permissionToCancel,
	type JobTarget,
	RERUN_FROM_ORIGIN,
	RERUN_FROM_PROJECT,
	RERUN_FROM_RUNNER,
	rerunRouteOf,
} from "@/lib/jobs/operation";

/** Each kind as it is STORED: where its target lives (the column, or only the snapshot). */
const STORED: Record<ProvisionJobType, JobTarget> = {
	PLAN: { job_type: "PLAN", project_id: "p", environment_id: "e" },
	DEPLOY: { job_type: "DEPLOY", project_id: "p", environment_id: "e" },
	DESTROY: { job_type: "DESTROY", project_id: "p", environment_id: "e" },
	BUILD: { job_type: "BUILD", project_id: "p", environment_id: "e" },
	DETECT_DRIFT: { job_type: "DETECT_DRIFT", project_id: "p", environment_id: "e" },
	PROBE_CLUSTER: { job_type: "PROBE_CLUSTER", project_id: "p", environment_id: "e" },
	MINT_KUBECONFIG: { job_type: "MINT_KUBECONFIG", project_id: "p", environment_id: "e" },
	STATE_SURGERY: { job_type: "STATE_SURGERY", project_id: "p", environment_id: "e" },
	// The scans: their project sits in the snapshot (and, since #6121, in the column too).
	IAC_SCAN: { job_type: "IAC_SCAN", project_id: null, environment_id: null, config_snapshot: { project_id: "p" } },
	CHART_SCAN: { job_type: "CHART_SCAN", project_id: null, environment_id: null, config_snapshot: { project_id: "p" } },
	// A runner's lifecycle: the runner sits in the snapshot; there is no project.
	DEPLOY_RUNNER: { job_type: "DEPLOY_RUNNER", project_id: null, environment_id: null, config_snapshot: { runner_id: "r" } },
	UPDATE_RUNNER: { job_type: "UPDATE_RUNNER", project_id: null, environment_id: null, config_snapshot: { runner_id: "r" } },
	DESTROY_RUNNER: { job_type: "DESTROY_RUNNER", project_id: null, environment_id: null, config_snapshot: { runner_id: "r" } },
	ANALYZE_REPO: { job_type: "ANALYZE_REPO", project_id: null, environment_id: null, config_snapshot: { repo_url: "x" } },
	AUDIT: { job_type: "AUDIT", project_id: null, environment_id: null },
};

/** How each stored kind is re-run. */
const RERUN: Record<ProvisionJobType, ReturnType<typeof rerunRouteOf>> = {
	PLAN: { kind: "project", operation: "plan", projectId: "p", environmentId: "e" },
	DEPLOY: { kind: "project", operation: "deploy", projectId: "p", environmentId: "e" },
	DESTROY: { kind: "project", operation: "destroy", projectId: "p", environmentId: "e" },
	BUILD: { kind: "refuse", reason: RERUN_FROM_PROJECT },
	DETECT_DRIFT: { kind: "refuse", reason: RERUN_FROM_PROJECT },
	PROBE_CLUSTER: { kind: "refuse", reason: RERUN_FROM_PROJECT },
	MINT_KUBECONFIG: { kind: "refuse", reason: RERUN_FROM_PROJECT },
	STATE_SURGERY: { kind: "refuse", reason: RERUN_FROM_PROJECT },
	IAC_SCAN: { kind: "refuse", reason: RERUN_FROM_PROJECT },
	CHART_SCAN: { kind: "refuse", reason: RERUN_FROM_PROJECT },
	DEPLOY_RUNNER: { kind: "refuse", reason: RERUN_FROM_RUNNER },
	UPDATE_RUNNER: { kind: "refuse", reason: RERUN_FROM_RUNNER },
	DESTROY_RUNNER: { kind: "refuse", reason: RERUN_FROM_RUNNER },
	ANALYZE_REPO: { kind: "refuse", reason: RERUN_FROM_ORIGIN },
	AUDIT: { kind: "copy" },
};

/** The permission cancelling each stored kind takes on its target. */
const CANCEL: Record<ProvisionJobType, ReturnType<typeof permissionToCancel>> = {
	PLAN: { type: "project", action: "plan", id: "p" },
	DEPLOY: { type: "project", action: "deploy", id: "p" },
	DESTROY: { type: "project", action: "destroy", id: "p" },
	BUILD: { type: "project", action: "deploy", id: "p" },
	DETECT_DRIFT: { type: "project", action: "deploy", id: "p" },
	PROBE_CLUSTER: { type: "project", action: "deploy", id: "p" },
	MINT_KUBECONFIG: { type: "project", action: "deploy", id: "p" },
	STATE_SURGERY: { type: "project", action: "deploy", id: "p" },
	// A scan's project is read from its snapshot when the column is empty (scans stored before #6121).
	IAC_SCAN: { type: "project", action: "edit", id: "p" },
	CHART_SCAN: { type: "project", action: "edit", id: "p" },
	DEPLOY_RUNNER: { type: "runner", action: "deploy", id: "r" },
	UPDATE_RUNNER: { type: "runner", action: "edit", id: "r" },
	DESTROY_RUNNER: { type: "runner", action: "destroy", id: "r" },
	ANALYZE_REPO: null,
	AUDIT: null,
};

const ALL: ProvisionJobType[] = [...provisionJobType.enumValues];

describe("rerunRouteOf — every job kind, as stored", () => {
	it("the tables name every kind in the enum", () => {
		expect(Object.keys(STORED).sort()).toEqual([...ALL].sort());
	});

	it.each(ALL)("%s", (kind) => {
		expect(rerunRouteOf(STORED[kind])).toEqual(RERUN[kind]);
	});

	it("only an allow-listed kind is ever copied — never because its project column is empty", () => {
		const copied = ALL.filter((kind) => rerunRouteOf({ job_type: kind, project_id: null, environment_id: null }).kind === "copy");
		expect(copied).toEqual(["AUDIT"]);
	});

	it("an AUDIT of a project, or of an environment, is not copied", () => {
		expect(rerunRouteOf({ job_type: "AUDIT", project_id: "p", environment_id: null }).kind).toBe("refuse");
		expect(rerunRouteOf({ job_type: "AUDIT", project_id: null, environment_id: "e" }).kind).toBe("refuse");
	});

	it("a plan, deploy or destroy whose project is gone is not re-run from the job", () => {
		expect(rerunRouteOf({ job_type: "DEPLOY", project_id: null, environment_id: "e" })).toEqual({
			kind: "refuse",
			reason: RERUN_FROM_PROJECT,
		});
	});
});

describe("permissionToCancel — every job kind, as stored", () => {
	it.each(ALL)("%s", (kind) => {
		expect(permissionToCancel(STORED[kind])).toEqual(CANCEL[kind]);
	});

	it("a scan stamped with its project takes edit on that project; one naming no project has no target", () => {
		expect(permissionToCancel({ job_type: "IAC_SCAN", project_id: "p", environment_id: null })).toEqual({
			type: "project",
			action: "edit",
			id: "p",
		});
		expect(permissionToCancel({ job_type: "CHART_SCAN", project_id: null, environment_id: null, config_snapshot: {} })).toEqual({
			type: "project",
			action: "edit",
			id: null,
		});
	});

	it("a runner job whose snapshot names no runner has no nameable target", () => {
		expect(permissionToCancel({ job_type: "DESTROY_RUNNER", project_id: null, environment_id: null, config_snapshot: {} })).toEqual({
			type: "runner",
			action: "destroy",
			id: null,
		});
	});
});
