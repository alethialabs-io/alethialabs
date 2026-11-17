// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// WHICH ENVIRONMENTS BLOCK A DELETE (#6752).
//
// Deleting a project, an environment or an organization removes ROWS. It runs no destroy job, so
// whatever the environment provisioned keeps running in the customer's cloud with nothing left in
// the console that names it. Each of those deletes is therefore refused while an environment under
// it is live or in flight, and the answer to "is it?" is this one set: `deleteProject`,
// `deleteEnvironment` (app/server/actions/projects.ts) and `deleteOrganization`
// (app/server/actions/org-settings.ts) all read it from here, so the three cannot disagree about
// which statuses count.
//
// This is the first blocker of the delete-blocker model. Listing every blocker before the delete,
// and resolving one by destroy or by release, is a later unit; this refusal stays as the server's
// backstop under it.

import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { projectEnvironments, projects } from "@/lib/db/schema";
import type { ProjectStatus } from "@/lib/db/schema/enums";

/**
 * The environment statuses that mean cloud infrastructure exists or is being changed right now:
 * waiting for a runner, being provisioned, running, or being torn down. `DRAFT` and `DESTROYED`
 * have nothing provisioned; `FAILED` is not in the set, as it was not in `deleteProject`'s.
 */
export const LIVE_ENV_STATUSES: ReadonlySet<ProjectStatus> = new Set<ProjectStatus>([
	"QUEUED",
	"PROVISIONING",
	"ACTIVE",
	"DESTROYING",
]);

/** Whether an environment in `status` is live or in flight, and so blocks a delete above it. */
export function isLiveEnvStatus(status: ProjectStatus): boolean {
	return LIVE_ENV_STATUSES.has(status);
}

/** One environment that blocks a delete: its own name and its project's. */
export interface LiveEnvironment {
	projectName: string;
	environmentName: string;
}

/** How many blocking environments a refusal names before it counts the rest. */
export const LIVE_ENVIRONMENTS_NAMED = 5;

/** The refusal for deleting one environment that is itself live or in flight. */
export const LIVE_ENVIRONMENT_REFUSAL = "Destroy this environment before deleting it.";

/**
 * The refusal for deleting an organization that still has live or in-flight environments. It names
 * the first {@link LIVE_ENVIRONMENTS_NAMED} as `project / environment` and counts the rest, so the
 * reader knows where to go without the sentence growing with the organization.
 */
export function liveEnvironmentsRefusal(blockers: readonly LiveEnvironment[]): string {
	const named = blockers
		.slice(0, LIVE_ENVIRONMENTS_NAMED)
		.map((b) => `${b.projectName} / ${b.environmentName}`)
		.join(", ");
	const rest = blockers.length - LIVE_ENVIRONMENTS_NAMED;
	const more = rest > 0 ? ` and ${rest} more` : "";
	const noun = blockers.length === 1 ? "a live or in-flight environment" : "live or in-flight environments";
	const them = blockers.length === 1 ? "it" : "them";
	return `This organization has ${noun}: ${named}${more}. Destroy ${them} before deleting the organization.`;
}

/**
 * The live or in-flight environments of every project in `orgId`, ordered by project then
 * environment name so a refusal names the same ones each time.
 *
 * Keyed on `projects.org_id` rather than the environment's own `org_id`: the project's is the one
 * every insert sets. The caller passes the client — the service client for an organization delete,
 * which must see every member's projects, not only the caller's.
 */
export async function liveEnvironmentsInOrg(
	db: Pick<Db, "select">,
	orgId: string,
): Promise<LiveEnvironment[]> {
	const orgProjects = await db
		.select({ id: projects.id, name: projects.project_name })
		.from(projects)
		.where(eq(projects.org_id, orgId));
	if (orgProjects.length === 0) return [];
	const projectNames = new Map(orgProjects.map((p) => [p.id, p.name]));
	const environments = await db
		.select({
			projectId: projectEnvironments.project_id,
			name: projectEnvironments.name,
			status: projectEnvironments.status,
		})
		.from(projectEnvironments)
		.where(inArray(projectEnvironments.project_id, [...projectNames.keys()]));
	return environments
		.filter((e) => isLiveEnvStatus(e.status))
		.map((e) => ({
			projectName: projectNames.get(e.projectId) ?? "",
			environmentName: e.name,
		}))
		.sort(
			(a, b) =>
				a.projectName.localeCompare(b.projectName) ||
				a.environmentName.localeCompare(b.environmentName),
		);
}
