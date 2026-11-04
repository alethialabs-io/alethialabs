// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use server";

// Server actions for the ephemeral PR-preview config (W-f, #842). A project has a single preview
// generator (one row in project_preview_config). savePreviewConfig upserts it; the runner
// renders an ArgoCD ApplicationSet Pull Request generator from it at deploy
// (packages/core/argocd/applicationset_preview.go): create-on-open, deploy head_sha,
// destroy-on-close. Placement (namespace|vcluster) is the per-team tenancy of each preview.

import { eq } from "drizzle-orm";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { projectPreviewConfig, projects } from "@/lib/db/schema";
import {
	type PreviewConfigParsed,
	previewConfigSchema,
} from "@/lib/validations/preview";

/** The save's input: the project and the settings the user edited, under the shared schema. */
const savePreviewInput = z.object({ projectId: z.uuid(), config: previewConfigSchema });

/**
 * Creates or updates a project's ephemeral PR-preview config (one row per project, upserted on
 * project_id), so the runner can render the preview ApplicationSet. Answers in the mutation
 * contract (ADR 0005 D4, #6128): a field the schema refuses comes back as a field error, a caller
 * without `edit` on the project as `forbidden`, a project that is gone as `not-found` — never a
 * thrown message a production build redacts.
 */
export async function savePreviewConfig(
	raw: z.input<typeof savePreviewInput>,
): Promise<ActionResult<{ config: typeof projectPreviewConfig.$inferSelect }>> {
	return defineAction({
		input: savePreviewInput,
		run: ({ input }) => writePreviewConfig(input.projectId, input.config),
	})(raw);
}

/** The body of {@link savePreviewConfig}, once its input has been validated. */
async function writePreviewConfig(projectId: string, parsed: PreviewConfigParsed) {
	const actor = await authorize("edit", { type: "project", id: projectId });
	return withActorScope(actor, async (tx) => {
		const [project] = await tx
			.select({ org_id: projects.org_id })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		if (!project) throw new ActionRefusal("not-found", "This project no longer exists.");

		const [row] = await tx
			.insert(projectPreviewConfig)
			.values({
				project_id: projectId,
				user_id: actor.userId,
				org_id: project.org_id,
				...parsed,
			})
			.onConflictDoUpdate({
				target: projectPreviewConfig.project_id,
				set: { ...parsed, updated_at: new Date() },
			})
			.returning();
		return { config: row };
	});
}

/**
 * Enables or disables previews for a project without touching the rest of the config. A thin
 * convenience over savePreviewConfig for the common toggle; requires the config to
 * already exist (throws otherwise, so we never persist a half-configured, credential-less generator).
 */
export async function setPreviewEnabled(projectId: string, enabled: boolean) {
	const actor = await authorize("edit", { type: "project", id: projectId });
	return withActorScope(actor, async (tx) => {
		const [row] = await tx
			.update(projectPreviewConfig)
			.set({ enabled, updated_at: new Date() })
			.where(eq(projectPreviewConfig.project_id, projectId))
			.returning();
		if (!row) {
			throw new Error("Preview environments are not configured for this project");
		}
		return { config: row };
	});
}
