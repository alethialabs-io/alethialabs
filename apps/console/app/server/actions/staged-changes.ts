"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { asRecord } from "@/lib/records";
import { withActorScope } from "@/lib/db";
import { projectChanges } from "@/lib/db/schema";
import type { StagedChangePayload } from "@/types/jsonb.types";
// The differ is a PURE function, so it cannot be exported from this module: `"use server"` requires
// every export to be async. See lib/config-diff.ts.
import { diffConfig } from "@/lib/config-diff";
import {
	type CreateProjectInput,
	getProjectAsFormData,
	updateProjectDesign,
} from "./projects";

/** Scopes the staging rows to one (project, environment) — the canvas always edits the env in
 * `?environment_id=`, so each environment owns its own pending diff. */
function changeScope(projectId: string, environmentId: string) {
	return and(
		eq(projectChanges.project_id, projectId),
		eq(projectChanges.environment_id, environmentId),
	);
}

/** An environment's durable staged changes (canvas diff), newest patches last. */
export async function listStagedChanges(
	projectId: string,
	environmentId: string,
) {
	const actor = await authorize("view", { type: "project", id: projectId });
	return withActorScope(actor, (tx) =>
		tx
			.select()
			.from(projectChanges)
			.where(changeScope(projectId, environmentId))
			.orderBy(projectChanges.created_at),
	);
}

/**
 * Replace an environment's staged changes with the diff of the desired canvas config against
 * that environment's live config — so the Pending Changes bar is durable + shared across sessions.
 */
export async function stageChanges(
	projectId: string,
	environmentId: string,
	data: CreateProjectInput,
) {
	const actor = await authorize("edit", { type: "project", id: projectId });
	const owner = actor.userId;
	const live = await getProjectAsFormData(projectId, environmentId)
		.then((r) => r.formData)
		.catch(() => null);
	const rows = diffConfig(live, data);
	return withActorScope(actor, async (tx) => {
		await tx.delete(projectChanges).where(changeScope(projectId, environmentId));
		if (rows.length)
			await tx.insert(projectChanges).values(
				rows.map((r) => ({
					project_id: projectId,
					environment_id: environmentId,
					user_id: owner,
					...r,
				})),
			);
		return { count: rows.length };
	});
}

/** Clear an environment's staged changes (the Discard action). */
export async function discardStagedChanges(
	projectId: string,
	environmentId: string,
) {
	const actor = await authorize("edit", { type: "project", id: projectId });
	return withActorScope(actor, async (tx) => {
		await tx.delete(projectChanges).where(changeScope(projectId, environmentId));
		return { success: true };
	});
}

/**
 * Apply the desired config to the environment's live component tables (updateProjectDesign) and
 * clear its staged rows. The canvas is the source of truth, so the full desired config is passed
 * in; the staged rows are the durable record of *what* changed for the bar.
 */
export async function applyStagedChanges(
	projectId: string,
	environmentId: string,
	data: CreateProjectInput,
) {
	await updateProjectDesign(projectId, environmentId, data);
	const actor = await authorize("edit", { type: "project", id: projectId });
	await withActorScope(actor, async (tx) => {
		await tx.delete(projectChanges).where(changeScope(projectId, environmentId));
	});
	return { success: true };
}
