"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "MARK AS DESTROYED" — A PERSON'S RULING ON A CLUSTER FOUND DELETED OUTSIDE ALETHIA (#6736).
//
// When a drift scan or probe shows an environment's cluster gone, Alethia says so and changes
// nothing (lib/clusters/missing.ts). The user has three ways out: redeploy (the existing deploy),
// tear down (the existing environment destroy), or — when the cluster is gone for good — record it
// as destroyed. This is the third. It:
//
//   · takes the SAME permission the environment destroy takes (`project:destroy`);
//   · re-derives the observation HERE, from the same readings every surface uses, and refuses unless
//     it is still `missing` — a card painted an hour ago is not evidence, and a redeploy since then
//     may have recreated the cluster;
//   · moves the environment to DESTROYED through the env-status CAS (`markDestroyed`, only off a
//     settled environment — never one with a job in flight) and marks its cluster rows DESTROYED,
//     the same two writes a successful DESTROY's writeback makes (lib/jobs/finalize-deployment.ts);
//   · touches NOTHING in the cloud and queues no job. What may still exist there is the user's to
//     check, and the confirmation dialog says so;
//   · deletes nothing: jobs, drift scans, probes, the design and the activity log all stay;
//   · records an activity-log row naming the actor and the evidence it was decided on.

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal } from "@/lib/actions/result";
import { emitActionEvent } from "@/lib/alerts/emit";
import { recordActivity } from "@/lib/authz/activity";
import { authorizeDeferred } from "@/lib/authz/guard";
import { environmentLabel, readEnvironmentObservation } from "@/lib/clusters/missing";
import { missingEvidence } from "@/lib/clusters/observed-state";
import { withActorScope } from "@/lib/db";
import { transitionEnv } from "@/lib/db/env-status";
import { projectCluster, projectEnvironments } from "@/lib/db/schema";

/** The activity-log action a "Mark as destroyed" records. */
const MARK_DESTROYED_ACTION = "mark_destroyed";

// Not exported: a "use server" module may export only async functions.

/** The refusal when the cluster is no longer observed missing. */
const NOT_MISSING_REFUSAL =
	"Not marked: Alethia's latest check no longer shows this cluster missing. Reload to see its current state.";

/** The refusal when the environment has a job in flight (its runner will record the outcome). */
const IN_FLIGHT_REFUSAL =
	"Not marked: a job is running on this environment. Wait for it to finish, then check again.";

const markDestroyedInput = z.object({ projectId: z.string().uuid(), environmentId: z.string().uuid() });

/** Records a missing cluster's environment as destroyed, without a cloud call (see the file header). */
async function markDestroyed(projectId: string, environmentId: string): Promise<{ environmentId: string }> {
	const actor = await authorizeDeferred("destroy", { type: "project", id: projectId });

	// Re-derived server-side, inside the actor's org; an environment of another project is not found.
	const observed = await readEnvironmentObservation(actor.orgId, environmentId);
	if (!observed || observed.projectId !== projectId) {
		throw new ActionRefusal("not-found", "Environment not found.");
	}
	if (observed.observation.kind !== "missing") throw new ActionRefusal("conflict", NOT_MISSING_REFUSAL);
	const evidence = missingEvidence(observed.observation);

	await withActorScope(actor, async (tx) => {
		// Silent: a refusal is answered to the person who clicked, as a conflict, not paged as one.
		const moved = await transitionEnv(tx, environmentId, "markDestroyed", null, {
			orgId: actor.orgId,
			projectId,
			silent: true,
		});
		if (!moved) throw new ActionRefusal("conflict", IN_FLIGHT_REFUSAL);
		const now = new Date();
		await tx
			.update(projectEnvironments)
			.set({ last_deployed_at: null, updated_at: now })
			.where(eq(projectEnvironments.id, environmentId));
		await tx
			.update(projectCluster)
			.set({ status: "DESTROYED", updated_at: now })
			.where(and(eq(projectCluster.project_id, projectId), eq(projectCluster.environment_id, environmentId)));
	});

	recordActivity(
		actor,
		MARK_DESTROYED_ACTION,
		{ type: "environment", id: environmentId },
		{
			resourceName: environmentLabel(observed),
			reason: `Recorded as destroyed without a cloud call. Evidence: ${evidence}`,
		},
	);
	// The authz half of the record: an org's "Sensitive action allowed" rule sees this as the destroy
	// permission it was decided on.
	emitActionEvent(actor, "destroy", { type: "project", id: projectId }, true);
	return { environmentId };
}

/**
 * Records an environment whose cluster Alethia observes missing as DESTROYED — the environment and
 * its cluster rows — with no cloud call and no job. Refused unless the cluster is still observed
 * missing, and while a job runs on the environment.
 */
export async function markEnvironmentDestroyedAction(raw: z.input<typeof markDestroyedInput>) {
	return defineAction({
		input: markDestroyedInput,
		run: ({ input }) => markDestroyed(input.projectId, input.environmentId),
	})(raw);
}
