"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE ARCHITECTURE BOARD'S DESIGN AND JOB WRITES, ON THE MUTATION CONTRACT (ADR 0005 §D4, #6119).
//
// Save, Deploy, Discard, Destroy, the create flow's Save and the Run menu's Plan and Detect drift
// all run functions that live with the project domain (`projects.ts`, `staged-changes.ts`) and that
// the CLI, the jobs API and the assistant call too, in their own shapes. These actions are the
// board's door to them: each parses its input, resolves the environment inside the actor's org
// (`resolveActiveEnvironmentId` joins the project's org, so a foreign project's id resolves to
// nothing and writes nothing), runs the SAME function every other caller runs — so each authorize,
// gate and refusal is the one that already exists — and answers an `ActionResult` whose refusals the
// board renders by kind.
//
// Each is a plain async function whose body builds its contract inline, so the action-boundary guard
// (scripts/check-action-boundary.mjs) follows it to the function it runs and on to its `authorize`.

import { z } from "zod";
import { tryCreateProject, tryDestroyProject, tryPlanProject, tryProvisionProject, tryQueueDriftDetection } from "@/app/server/actions/projects";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { applyStagedChanges, discardStagedChanges } from "@/app/server/actions/staged-changes";
import { readDestroyTree } from "@/lib/rpc/procedures/canvas";
import { defineAction } from "@/lib/actions/define-action";
import { refusingCanvasWrite, returnedRefusalAsConflict } from "@/lib/canvas/write-refusals";
import { projectFormSchema } from "@/lib/validations/project-form.schema";

const uuid = z.string().uuid();

/** A project and one of its environments; a null environment means the project's default one. */
const environmentInput = z.object({
	projectId: uuid,
	environmentId: uuid.nullable(),
});

/** An environment's design write: the board's desired config for that environment. */
const designInput = environmentInput.extend({ design: projectFormSchema });

/**
 * Saves the board's design to the environment WITHOUT provisioning it: the live design tables and
 * the durable staged rows. Answers the environment it resolved.
 */
export async function saveDesignAction(raw: z.input<typeof designInput>) {
	return defineAction({
		input: designInput,
		run: async ({ input }) =>
			refusingCanvasWrite(async () => {
				const environmentId = await resolveActiveEnvironmentId(input.projectId, input.environmentId);
				await applyStagedChanges(input.projectId, environmentId, input.design);
				return { environmentId };
			}),
	})(raw);
}

/**
 * Saves the board's design to the environment, then queues its DEPLOY. A refused deploy (no cloud
 * account, a job already in flight, the job cap) is a `conflict` — the design IS saved by then, and
 * only the deploy was refused. Answers the environment and the queued job.
 */
export async function deployDesignAction(raw: z.input<typeof designInput>) {
	return defineAction({
		input: designInput,
		run: async ({ input }) => {
			const environmentId = await refusingCanvasWrite(async () => {
				const resolved = await resolveActiveEnvironmentId(input.projectId, input.environmentId);
				await applyStagedChanges(input.projectId, resolved, input.design);
				return resolved;
			});
			const { jobId } = await returnedRefusalAsConflict(() =>
				tryProvisionProject(input.projectId, undefined, undefined, environmentId),
			);
			return { environmentId, jobId };
		},
	})(raw);
}

/** Clears the environment's staged changes (the pending-changes bar's Discard). */
export async function discardStagedDesignAction(raw: z.input<typeof environmentInput>) {
	return defineAction({
		input: environmentInput,
		run: async ({ input }) =>
			refusingCanvasWrite(async () => {
				const environmentId = await resolveActiveEnvironmentId(input.projectId, input.environmentId);
				await discardStagedChanges(input.projectId, environmentId);
				return { environmentId };
			}),
	})(raw);
}

/** A destroy names its environment: there is no "the default" to fall back onto. */
const destroyInput = z.object({ projectId: uuid, environmentId: uuid, cascade: z.boolean() });

/**
 * Queues the DESTROY of exactly the named environment — with `cascade`, every live tenant on the
 * cluster it owns too, tenants first. The target is resolved through the same read the dialog's
 * destroy tree came from (`readDestroyTree`: exact, inside the actor's org), NOT through
 * `resolveActiveEnvironmentId`, which falls back to the project's default environment — so a stale
 * id is a `not-found` and destroys nothing. A destroy that would orphan tenants without `cascade` is
 * a `conflict` naming them. Answers the environment and how many environments were queued.
 */
export async function destroyEnvironmentAction(raw: z.input<typeof destroyInput>) {
	return defineAction({
		input: destroyInput,
		run: async ({ input }) => {
			const { environmentId } = await refusingCanvasWrite(() =>
				readDestroyTree(input.projectId, input.environmentId),
			);
			const { jobs } = await returnedRefusalAsConflict(() =>
				tryDestroyProject(input.projectId, environmentId, null, { cascade: input.cascade }),
			);
			return { environmentId, queued: jobs.length };
		},
	})(raw);
}

const environmentJobInput = z.object({ projectId: uuid, environmentId: uuid });

/** Queues a PLAN of the environment (the Run menu); answers the queued job. */
export async function planEnvironmentAction(raw: z.input<typeof environmentJobInput>) {
	return defineAction({
		input: environmentJobInput,
		run: async ({ input }) => {
			const { jobId } = await returnedRefusalAsConflict(() =>
				tryPlanProject(input.projectId, null, input.environmentId),
			);
			return { jobId };
		},
	})(raw);
}

/** Queues a drift detection of the environment (the Run menu); answers the queued job. */
export async function detectDriftAction(raw: z.input<typeof environmentJobInput>) {
	return defineAction({
		input: environmentJobInput,
		run: async ({ input }) => {
			const { jobId } = await returnedRefusalAsConflict(() =>
				tryQueueDriftDetection(input.projectId, input.environmentId),
			);
			return { jobId };
		},
	})(raw);
}

const createInput = z.object({ design: projectFormSchema });

/**
 * The create flow's Save: turns the board's design into a new project. A name another project of the
 * org holds, or one that breaks the name rules, is a `conflict` with the sentence to show. Answers the
 * new project's slug.
 */
export async function createProjectFromDesignAction(raw: z.input<typeof createInput>) {
	return defineAction({
		input: createInput,
		run: async ({ input }) => {
			const { project } = await returnedRefusalAsConflict(() => tryCreateProject(input.design));
			return { projectId: project.id, slug: project.slug };
		},
	})(raw);
}
