// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// THE GENERAL-SETTINGS READS (ADR 0005 D1, #6128). The org's and the project's General settings,
// served over GET and prefetched in-process by their pages, so the form paints with its values and
// issues no request of its own on first load.
//
// The bodies MOVED here from the `"use server"` modules that served them as actions:
//   · readOrgGeneral      ← app/server/actions/org-settings.ts getOrgSettings (deleted)
//   · readProjectGeneral  ← app/server/actions/projects.ts getProjectGeneral (deleted), with the
//                           page's own `resolveProjectId` folded in: the page addressed the project
//                           by slug and resolved it in a second round trip.
//   · readPreviewSettings ← app/server/actions/preview.ts getPreviewConfig, listProjectFabrics and
//                           listProjectGitCredentials (deleted) — one read, since the page shows all
//                           three together and the three each asked the PDP the same question.
// The actor is the one the read router bound for the request's ADDRESS (`lib/rpc/base.ts`), never
// the session's org.

import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { ActionRefusal } from "@/lib/actions/result";
import { authorize } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { withActorScope } from "@/lib/db";
import {
	projectFabrics,
	projectGitCredentials,
	projectPreviewConfig,
	projects,
} from "@/lib/db/schema";
import { type OrgSettings, orgSettingsForOrg } from "@/lib/org/settings";
import { query } from "@/lib/rpc/base";

/**
 * The org General-settings read's answer. The personal workspace is a real tenant with no
 * organization behind it — no name, no slug, no metadata to edit — so it is answered AS SUCH, not
 * as `null`: a `null` read the old page could not tell from "still loading", and it drew a skeleton
 * forever (F050).
 */
export type OrgGeneralRead =
	| { scope: "personal" }
	| { scope: "organization"; settings: OrgSettings };

/**
 * The addressed org's General-settings values. Any member may read them (the PDP's `view` on the
 * org, which also refuses a member whose membership is not active); a missing org row — deleted
 * between the address resolving and this read — is NOT_FOUND, never an empty form.
 */
export async function readOrgGeneral(actor: Actor): Promise<OrgGeneralRead> {
	if (actor.orgId === actor.userId) return { scope: "personal" };
	await authorize("view", { type: "org" });
	const settings = await orgSettingsForOrg(actor.orgId);
	if (!settings) throw new ActionRefusal("not-found", "This organization no longer exists.");
	return { scope: "organization", settings };
}

/** The editable general fields of a project (project → Settings → General). */
export interface ProjectGeneral {
	id: string;
	project_name: string;
	slug: string | null;
}

/**
 * The addressed project's General fields, by its slug in the addressed org — or `null` when no
 * project in that org has the slug (a stale link, a project renamed away, one deleted in another
 * tab). The page turns `null` into its 404; a project the caller may not see is FORBIDDEN.
 *
 * The slug resolves inside the addressed org EXPLICITLY (`org_id = actor.orgId`, under RLS as
 * well), and then the PDP's `view` on the project decides — so a project grant narrower than the org
 * is honoured, and a same-slug project in the caller's personal scope is never the answer.
 */
async function readProjectGeneral(
	actor: Actor,
	projectSlug: string,
): Promise<ProjectGeneral | null> {
	const row = await withActorScope(actor, async (tx) => {
		const [found] = await tx
			.select({ id: projects.id, project_name: projects.project_name, slug: projects.slug })
			.from(projects)
			// The ADDRESSED org's project, named explicitly. RLS alone admits two arms (`org_id =
			// current_org OR org_id = current_owner`), so inside an org the caller's PERSONAL projects
			// are visible too, and a personal project under the same slug could otherwise be the row
			// this answered — and the page's Rename and Delete would then act on it.
			.where(and(eq(projects.slug, projectSlug), eq(projects.org_id, actor.orgId)))
			.limit(1);
		return found ?? null;
	});
	if (!row) return null;
	await authorize("view", { type: "project", id: row.id });
	return row;
}

/** The project's preview-generator config row (`project_preview_config`), as stored. */
export type PreviewConfigRow = typeof projectPreviewConfig.$inferSelect;

/** A fabric a preview can be placed on. */
export interface PreviewFabricOption {
	id: string;
	name: string;
	region: string | null;
	status: (typeof projectFabrics.$inferSelect)["status"];
}

/** A project git credential, for the preview's ArgoCD credential picker. */
export interface PreviewGitCredentialOption {
	id: string;
	purpose: (typeof projectGitCredentials.$inferSelect)["purpose"];
	method: (typeof projectGitCredentials.$inferSelect)["method"];
}

/** Everything the project's Preview environments settings page shows. */
export interface PreviewSettingsRead {
	projectId: string;
	/** The preview generator's config, or null when previews were never configured. */
	config: PreviewConfigRow | null;
	fabrics: PreviewFabricOption[];
	gitCredentials: PreviewGitCredentialOption[];
}

/**
 * The addressed project's preview settings, by its slug in the addressed org — or `null` when no
 * project there has the slug (the page's 404). One PDP `view` on the project gates all three reads,
 * which then run in one RLS-scoped transaction.
 */
async function readPreviewSettings(
	actor: Actor,
	projectSlug: string,
): Promise<PreviewSettingsRead | null> {
	const project = await readProjectGeneral(actor, projectSlug);
	if (!project) return null;
	return withActorScope(actor, async (tx) => {
		const [config] = await tx
			.select()
			.from(projectPreviewConfig)
			.where(eq(projectPreviewConfig.project_id, project.id))
			.limit(1);
		const fabrics = await tx
			.select({
				id: projectFabrics.id,
				name: projectFabrics.name,
				region: projectFabrics.region,
				status: projectFabrics.status,
			})
			.from(projectFabrics)
			.where(eq(projectFabrics.project_id, project.id))
			.orderBy(asc(projectFabrics.name));
		const gitCredentials = await tx
			.select({
				id: projectGitCredentials.id,
				purpose: projectGitCredentials.purpose,
				method: projectGitCredentials.method,
			})
			.from(projectGitCredentials)
			.where(eq(projectGitCredentials.project_id, project.id));
		return { projectId: project.id, config: config ?? null, fabrics, gitCredentials };
	});
}

/** The input of {@link settingsRouter}'s project reads: the project's slug, as the URL carries it. */
const projectGeneralInput = z.object({ project: z.string().min(1).max(200) });

/**
 * The settings domain's reads (#6128). Each procedure starts from `query` in `@/lib/rpc/base`
 * (GET, typed refusals, the address's actor bound).
 */
export const settingsRouter = {
	org: query.handler(({ context }) => readOrgGeneral(context.actor)),
	project: query
		.input(projectGeneralInput)
		.handler(({ context, input }) => readProjectGeneral(context.actor, input.project)),
	preview: query
		.input(projectGeneralInput)
		.handler(({ context, input }) => readPreviewSettings(context.actor, input.project)),
};
