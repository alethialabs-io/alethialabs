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

/**
 * The state object key for a project's tofu state. `scopeId` is the immutable UUID of the infra
 * unit that OWNS the state: the environment id for a `dedicated` placement (the env owns its Fabric
 * 1:1 — the legacy env=cluster path) or the Fabric id for a shared `namespace`/`vcluster` placement
 * (every env on one Fabric shares a single state object). The path shape is identical either way.
 */
export function projectStateKey(projectId: string, scopeId: string): string {
	return `projects/${projectId}/${scopeId}/tofu.tfstate`;
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
 * - Project jobs key by the project UUID + the placement's owning infra unit (#838): the Fabric id
 *   for a shared `namespace`/`vcluster` placement (so every env on one Fabric shares a single state
 *   object), else the environment id for `dedicated` (the default + every backfilled env → the path
 *   is byte-identical to the pre-Fabric scheme, so no state object is orphaned).
 * - Runner-lifecycle jobs (which have NULL project/environment) key by `config_snapshot.runner_id`.
 *
 * Any snapshot-supplied id (`runner_id`, `fabric_id`) is **validated to be a canonical UUID** before
 * it touches the object key — a non-UUID value could otherwise inject a `../projects/{victim}/…`
 * traversal onto another tenant's state object.
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
	// #838: a shared placement keys the tofu state on its Fabric so co-Fabric environments share one
	// state object. `dedicated` (and any snapshot predating the Fabric fields) falls through to the
	// environment-keyed path — byte-identical, no state migration.
	const placementMode = job.config_snapshot.placement_mode;
	const fabricId = job.config_snapshot.fabric_id;
	if (placementMode !== undefined && placementMode !== "dedicated") {
		if (typeof fabricId !== "string" || !UUID_RE.test(fabricId)) {
			return {
				error: "Placement job has no valid fabric id",
				status: 400,
			};
		}
		return { key: projectStateKey(job.project_id, fabricId) };
	}
	return { key: projectStateKey(job.project_id, job.environment_id) };
}
