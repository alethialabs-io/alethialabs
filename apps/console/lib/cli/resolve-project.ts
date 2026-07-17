// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, asc, desc, eq, or } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { projectEnvironments, projects } from "@/lib/db/schema";

/** A v4-ish UUID, to decide whether to match an `[id]` segment against the id column
 * (comparing a non-uuid string to a uuid column would error at the DB). */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves a project the CLI addressed by id, name, OR slug, scoped to the active org.
 * Returns the project row or null. Mirrors the by-project-name read lookup but also
 * accepts the project id (and the URL slug), so authoring commands can target a project
 * the same way every other CLI command does.
 */
export async function resolveCliProject(orgId: string, idOrName: string) {
	const matchers = [
		eq(projects.project_name, idOrName),
		eq(projects.slug, idOrName),
	];
	if (UUID_RE.test(idOrName)) matchers.unshift(eq(projects.id, idOrName));

	const [row] = await getServiceDb()
		.select()
		.from(projects)
		.where(and(eq(projects.org_id, orgId), or(...matchers)))
		.limit(1);
	return row ?? null;
}

/**
 * The environment a single-value CLI command targets: the project's `is_default` environment, else
 * its earliest one. Component tables are UNIQUE on `(project_id, environment_id)`, so authoring a
 * component without this leaves it in a NULL env — invisible to the env-scoped deploy. Mirrors the
 * console's default-env pick (`server/actions/projects.ts`). Returns null only if the project somehow
 * has no environment (createProject always seeds one).
 */
export async function resolveDefaultEnvironmentId(
	projectId: string,
): Promise<string | null> {
	const [env] = await getServiceDb()
		.select({ id: projectEnvironments.id })
		.from(projectEnvironments)
		.where(eq(projectEnvironments.project_id, projectId))
		.orderBy(desc(projectEnvironments.is_default), asc(projectEnvironments.created_at))
		.limit(1);
	return env?.id ?? null;
}
