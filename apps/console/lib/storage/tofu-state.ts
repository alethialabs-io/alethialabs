// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProvisionJobType } from "@/lib/db/schema/enums";

/**
 * Object location for a project environment's tofu state, served by the console http-backend
 * proxy (E0). The key is derived from immutable UUIDs — NOT the human project name — because
 * `projects` is only `unique(org_id, slug)`, so a name-based key (the retired s3 scheme) would
 * collide two orgs' identically-named projects onto one state object. UUIDs are globally unique,
 * so the key is unambiguous across tenants. The console always derives this SERVER-SIDE from the
 * job row; a runner never supplies it.
 */
export const TOFU_STATE_BUCKET =
	process.env.ALETHIA_STORAGE_STATE_BUCKET || "project-tofu-state";

/** The state object key for a project environment. */
export function projectStateKey(
	projectId: string,
	environmentId: string,
): string {
	return `projects/${projectId}/${environmentId}/tofu.tfstate`;
}

/**
 * The state object key for a runner's self-deploy lifecycle (DEPLOY/UPDATE/DESTROY_RUNNER), keyed by
 * the TARGET runner's full UUID — the same object across the runner's deploy → update → destroy.
 */
export function runnerStateKey(runnerId: string): string {
	return `runners/${runnerId}/tofu.tfstate`;
}

/** Job types that provision a RUNNER (not a project) — their state keys by the target runner id. */
const RUNNER_LIFECYCLE_JOB_TYPES = new Set([
	"DEPLOY_RUNNER",
	"UPDATE_RUNNER",
	"DESTROY_RUNNER",
]);

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Derives the tofu-state object key for a job SERVER-SIDE. This is the SINGLE source of truth shared
 * by the state-token mint route and `resolveStateRequest`, so the token's `key` claim can never drift
 * from the key the state calls re-derive.
 *
 * - Project jobs key by the immutable project/environment UUIDs.
 * - Runner-lifecycle jobs (which have NULL project/environment) key by `config_snapshot.runner_id`.
 *   That target id is **validated to be a canonical UUID** before it touches the object key — a
 *   non-UUID value could otherwise inject a `../projects/{victim}/…` traversal onto another tenant's
 *   state object.
 */
export function stateKeyForJob(job: {
	job_type: ProvisionJobType;
	project_id: string | null;
	environment_id: string | null;
	config_snapshot: Record<string, unknown>;
}): { key: string } | { error: string; status: number } {
	if (RUNNER_LIFECYCLE_JOB_TYPES.has(job.job_type)) {
		const rid = job.config_snapshot.runner_id;
		if (typeof rid !== "string" || !UUID_RE.test(rid)) {
			return {
				error: "Runner-lifecycle job has no valid target runner id",
				status: 400,
			};
		}
		return { key: runnerStateKey(rid) };
	}
	if (!job.project_id || !job.environment_id) {
		return { error: "Job has no project environment", status: 400 };
	}
	return { key: projectStateKey(job.project_id, job.environment_id) };
}
