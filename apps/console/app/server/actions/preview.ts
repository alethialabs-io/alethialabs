// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use server";

// Server actions for the ephemeral PR-preview config (W-f, #842). A project has a single preview
// generator (one row in project_preview_config). configurePreviewEnvironments upserts it; the runner
// renders an ArgoCD ApplicationSet Pull Request generator from it at deploy
// (packages/core/argocd/applicationset_preview.go): create-on-open, deploy head_sha,
// destroy-on-close. Placement (namespace|vcluster) is the per-team tenancy of each preview.

import { asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import {
	projectFabrics,
	projectGitCredentials,
	projectPreviewConfig,
	projects,
} from "@/lib/db/schema";
import {
	type PreviewConfigInput,
	previewConfigSchema,
} from "@/lib/validations/preview";

/**
 * Reads a project's ephemeral-preview config, or null when previews aren't configured.
 */
export async function getPreviewConfig(projectId: string) {
	const actor = await authorize("view", { type: "project", id: projectId });
	return withActorScope(actor, async (tx) => {
		const [row] = await tx
			.select()
			.from(projectPreviewConfig)
			.where(eq(projectPreviewConfig.project_id, projectId))
			.limit(1);
		return row ?? null;
	});
}

/** Lists the project's fabrics for preview placement selection. */
export async function listProjectFabrics(projectId: string) {
	const actor = await authorize("view", { type: "project", id: projectId });
	return withActorScope(actor, (tx) =>
		tx
			.select({
				id: projectFabrics.id,
				name: projectFabrics.name,
				region: projectFabrics.region,
				status: projectFabrics.status,
			})
			.from(projectFabrics)
			.where(eq(projectFabrics.project_id, projectId))
			.orderBy(asc(projectFabrics.name)),
	);
}

/** Lists project git credentials for selectors; callers decide which purpose(s) apply. */
export async function listProjectGitCredentials(projectId: string) {
	const actor = await authorize("view", { type: "project", id: projectId });
	return withActorScope(actor, (tx) =>
		tx
			.select({
				id: projectGitCredentials.id,
				purpose: projectGitCredentials.purpose,
				method: projectGitCredentials.method,
			})
			.from(projectGitCredentials)
			.where(eq(projectGitCredentials.project_id, projectId)),
	);
}

/**
 * Creates or updates a project's ephemeral PR-preview config (one row per project, upserted on
 * project_id). Validates the input, then persists so the runner can render the preview
 * ApplicationSet. Throws when the project is missing or the caller lacks edit permission.
 */
export async function configurePreviewEnvironments(
	projectId: string,
	input: PreviewConfigInput,
) {
	const actor = await authorize("edit", { type: "project", id: projectId });
	const parsed = previewConfigSchema.parse(input);
	return withActorScope(actor, async (tx) => {
		const [project] = await tx
			.select({ org_id: projects.org_id })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		if (!project) notFound(); // stale/deleted id → 404, not a captured error

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
 * convenience over configurePreviewEnvironments for the common toggle; requires the config to
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
