"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Day-2 reconcile (Phase 3). Two divergence signals for an environment:
//   • cloud drift — live infra ≠ recorded state (DETECT_DRIFT refresh-only plan → environment_drift)
//   • config-vs-desired — the design moved ahead of what's deployed (structuralHash vs deployed_config_hash)
// getEnvReconcileStates powers the console's per-env badges. The self-heal that acts on drift,
// maybeAutoHeal, is service-role and lives in lib/reconcile/auto-heal.ts (see below).

import { and, desc, eq, isNotNull } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb, withActorScope } from "@/lib/db";
import { environmentDrift, jobs, projectEnvironments } from "@/lib/db/schema";
import { gitopsStatusReportSchema } from "@/lib/gitops/deploy-status";
import { structuralHash } from "@/lib/promotions/diff";
import { getLatestProbesByEnv } from "@/lib/probes/persistence";
import { getProjectAsFormData } from "./projects";

// maybeAutoHeal — the service-role re-apply the job-status route fires on drift — lives in
// lib/reconcile/auto-heal.ts. As an export of this `"use server"` file it was a public Server Action:
// anyone holding an environment id could enqueue a DEPLOY of its last-deployed design (#5219).

/** The latest cluster-alive probe facet of an env's reconcile state (BYOC B2). */
export interface EnvProbeState {
	/** True = API server answered, false = unreachable, null = never probed. */
	reachable: boolean | null;
	/** Short human-readable summary (esp. WHY unreachable). */
	message: string | null;
	/** When the last probe ran (RFC3339), null when never probed. */
	probedAt: string | null;
}

/**
 * Latest DELIVERY-drift signal for an environment (#841 split drift): whether the apps ArgoCD
 * Application is Synced. Reads the newest job carrying an `execution_metadata.gitops_status` for the
 * env (a DEPLOY or DETECT_DRIFT). true = Synced, false = OutOfSync, null = no ArgoCD status yet
 * (Unknown / never deployed). This is the delivery counterpart to the per-Fabric infra `driftInSync`.
 */
async function latestDeliveryInSync(
	db: ReturnType<typeof getServiceDb>,
	environmentId: string,
): Promise<boolean | null> {
	const [row] = await db
		.select({ execution_metadata: jobs.execution_metadata })
		.from(jobs)
		.where(
			and(
				eq(jobs.environment_id, environmentId),
				isNotNull(jobs.execution_metadata),
			),
		)
		.orderBy(desc(jobs.created_at))
		.limit(1);
	const parsed = gitopsStatusReportSchema.safeParse(
		row?.execution_metadata?.gitops_status,
	);
	if (!parsed.success || !parsed.data.app_health) return null;
	const sync = parsed.data.app_health.sync;
	return sync === "Synced" ? true : sync === "OutOfSync" ? false : null;
}

/** Per-environment reconcile state for the console's stability badges. */
export interface EnvReconcileState {
	environmentId: string;
	autoHeal: boolean;
	/**
	 * Latest INFRA drift posture (tofu refresh-only): true = in sync, false = drifted, null = never
	 * scanned. In the decoupled env-model this is the Fabric's infra signal (#841).
	 */
	driftInSync: boolean | null;
	/**
	 * Latest DELIVERY drift signal (ArgoCD apps Application sync, #841): true = Synced, false =
	 * OutOfSync, null = no ArgoCD status yet. Split from `driftInSync` — infra drifts per-Fabric,
	 * delivery drifts per-Environment; both are self-healed by the shared re-deploy.
	 */
	deliveryInSync: boolean | null;
	/** True when the env's designed structure has moved ahead of what's deployed. */
	deployPending: boolean;
	lastDeployedAt: string | null;
	/**
	 * Latest cluster-alive signal (BYOC B2). `reachable` null = never probed. The console badge
	 * pairs this with drift: drift answers "has it diverged?", probe answers "is it still up?".
	 */
	probe: EnvProbeState;
}

/** The reconcile state of every environment in a project (drift + config-vs-desired + auto-heal). */
export async function getEnvReconcileStates(
	projectId: string,
): Promise<EnvReconcileState[]> {
	const actor = await authorize("view", { type: "project", id: projectId });
	const envs = await withActorScope(actor, (tx) =>
		tx
			.select()
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, projectId)),
	);

	// Latest cluster-alive probe per env (BYOC B2), fetched once for the project (org-scoped join
	// inside). Envs never probed are simply absent → the badge shows null (never probed).
	const probesByEnv = await getLatestProbesByEnv(projectId, actor.orgId);

	return Promise.all(
		envs.map(async (env) => {
			const db = getServiceDb();
			const [drift] = await db
				.select({ in_sync: environmentDrift.in_sync })
				.from(environmentDrift)
				.where(eq(environmentDrift.environment_id, env.id))
				.orderBy(desc(environmentDrift.scanned_at))
				.limit(1);
			// #841: the delivery-drift signal (ArgoCD OutOfSync), read alongside infra drift.
			const deliveryInSync = await latestDeliveryInSync(db, env.id);
			// config-vs-desired: hash the current design and compare to what was last deployed.
			// Reading the design can throw (e.g. a since-deleted cloud identity); degrade that env
			// to "not pending" rather than failing the whole project's reconcile view.
			let deployPending = false;
			if (env.deployed_config_hash) {
				try {
					const design = (await getProjectAsFormData(projectId, env.id)).formData;
					deployPending = structuralHash(design) !== env.deployed_config_hash;
				} catch {
					deployPending = false;
				}
			}
			const probe = probesByEnv.get(env.id);
			return {
				environmentId: env.id,
				autoHeal: env.auto_heal,
				driftInSync: drift ? drift.in_sync : null,
				deliveryInSync,
				deployPending,
				lastDeployedAt: env.last_deployed_at?.toISOString() ?? null,
				probe: {
					reachable: probe ? probe.reachable : null,
					message: probe ? probe.message : null,
					probedAt: probe ? probe.probedAt : null,
				},
			};
		}),
	);
}
