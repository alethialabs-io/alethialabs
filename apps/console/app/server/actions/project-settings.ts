"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The project General-settings writes in the mutation contract (ADR 0005 D4, #6128): rename and
// delete, answering `ActionResult` so the form gets a pending state, a double-submit guard, field
// errors and invalidation from `useActionMutation`.
//
// The rules stay where they are — `updateProjectName` / `deleteProject` in projects.ts (the create
// path shares `projectNameProblem`, and the live-environment refusal belongs with the delete). This
// file adapts their `{ ok: false, error }` refusals onto the contract's kinds rather than restating
// a rule, so a name accepted on one screen cannot be refused on another.

import { z } from "zod";
import { deleteProject, updateProjectName } from "@/app/server/actions/projects";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult, FieldRefusal } from "@/lib/actions/result";
import { projectNameSchema } from "@/lib/validations/project-name";

/** The rename's input: the project and its new name, under the shared name rules. */
const renameInput = z.object({ projectId: z.uuid(), name: projectNameSchema });

/**
 * Renames a project (the slug stays, so URLs keep resolving). A name the server refuses — taken
 * by another project in the org, or one `projectNameProblem` rejects — comes back as a field error
 * on `name`, so the form shows it under the box that holds it.
 */
export async function renameProject(
	raw: z.input<typeof renameInput>,
): Promise<ActionResult<{ project_name: string }>> {
	return defineAction({
		input: renameInput,
		run: async ({ input }) => {
			const res = await updateProjectName(input.projectId, input.name);
			if (!res.ok) throw new FieldRefusal({ name: [res.error] }, res.error);
			return { project_name: res.project_name };
		},
	})(raw);
}

/** The delete's input: the project. */
const deleteInput = z.object({ projectId: z.uuid() });

/**
 * Deletes a project record (no cloud resources). Refused — as a `conflict` the danger zone renders
 * beside the button — while any environment is live or in flight.
 */
export async function removeProject(
	raw: z.input<typeof deleteInput>,
): Promise<ActionResult<{ deleted: true }>> {
	return defineAction({
		input: deleteInput,
		run: async ({ input }): Promise<{ deleted: true }> => {
			const res = await deleteProject(input.projectId);
			if (!res.ok) throw new ActionRefusal("conflict", res.error);
			return { deleted: true };
		},
	})(raw);
}
