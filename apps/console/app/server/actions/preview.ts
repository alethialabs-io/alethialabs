// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use server";

// Server actions for the ephemeral PR-preview config (W-f, #842). A project has a single preview
// generator (one row in project_preview_config). savePreviewConfig upserts it; the runner
// renders an ArgoCD ApplicationSet Pull Request generator from it at deploy
// (packages/core/argocd/applicationset_preview.go): create-on-open, deploy head_sha,
// destroy-on-close. Placement (namespace|vcluster) is the per-team tenancy of each preview.

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult, FieldRefusal } from "@/lib/actions/result";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { projectAddons, projectPreviewConfig, projects } from "@/lib/db/schema";
import { byoChartNamespace, byoPreviewNamespaceMessage } from "@/lib/validations/byo-charts";
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

		// The prefix this save leaves the project with: the one sent, else the stored one, else the
		// column's default for a new row. Only a CHANGE is checked against the attached charts (#6494).
		const [existing] = await tx
			.select({ namespace_prefix: projectPreviewConfig.namespace_prefix })
			.from(projectPreviewConfig)
			.where(eq(projectPreviewConfig.project_id, projectId))
			.limit(1);
		const prefix = parsed.namespace_prefix || existing?.namespace_prefix || DEFAULT_PREVIEW_PREFIX;
		if (existing?.namespace_prefix !== prefix) {
			const charts = await tx
				.select({ addon_id: projectAddons.addon_id, namespace: projectAddons.namespace })
				.from(projectAddons)
				.where(and(eq(projectAddons.project_id, projectId), eq(projectAddons.source, "byo")));
			const refusal = previewPrefixConflict(prefix, charts);
			if (refusal) throw new FieldRefusal({ "config.namespace_prefix": [refusal] }, refusal);
		}

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

/** The `namespace_prefix` column's default — what a new row stores when the save sends none. */
const DEFAULT_PREVIEW_PREFIX = "preview";

/**
 * Why `prefix` may not become the project's preview namespace prefix, or `null` (#6494): it would make
 * an attached BYO chart's namespace one of the project's preview namespaces
 * ({@link byoPreviewNamespaceMessage}, the same rule the attach action applies the other way round).
 *
 * Refused rather than saved with a warning. The other choices are worse: saving it would put a running
 * chart in a namespace the untrusted preview project may sync into, and the runner deliberately does
 * not move or refuse a live chart (that would break its Services or withdraw its secrets), so nothing
 * would ever undo it. Refusing here is the one point where a person is present to pick another prefix.
 *
 * A chart's namespace is read as the runner deploys it: blank, or the legacy `default` the runner moves
 * out of, is the chart's own `byo-<chart id>`. Charts of every environment count, since the prefix is
 * the project's.
 */
function previewPrefixConflict(
	prefix: string,
	charts: readonly { addon_id: string; namespace: string | null }[],
): string | null {
	const hits = charts.flatMap((c) => {
		const namespace =
			c.namespace && c.namespace !== "default" ? c.namespace : byoChartNamespace(c.addon_id);
		return byoPreviewNamespaceMessage(namespace, prefix) ? [`“${c.addon_id}” (namespace “${namespace}”)`] : [];
	});
	if (hits.length === 0) return null;
	const which =
		hits.length === 1
			? `BYO chart ${hits[0]} already deploys into one`
			: `BYO charts ${hits.join(", ")} already deploy into them`;
	return `The namespace prefix “${prefix}” would make “${prefix}” and every namespace starting with “${prefix}-” this project's preview namespaces, and its ${which}. Choose another prefix, or first attach the chart again with another namespace.`;
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
