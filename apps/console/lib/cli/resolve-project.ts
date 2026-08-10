// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, asc, desc, eq, or } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { projectEnvironments, projects } from "@/lib/db/schema";
import { environmentStage } from "@/lib/db/schema/enums";

/** A v4-ish UUID, to decide whether to match an `[id]` segment against the id column
 * (comparing a non-uuid string to a uuid column would error at the DB). */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Type guard: narrows an arbitrary string to a valid environment stage so it can
 * be compared against the pgEnum `stage` column without a cast. */
function isEnvironmentStage(
	s: string,
): s is (typeof environmentStage.enumValues)[number] {
	return environmentStage.enumValues.some((v) => v === s);
}

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

/** The outcome of picking a CLI write's target environment. The two failure modes are kept
 * DISTINCT because they deserve different statuses and different messages: a name the caller got
 * wrong is a 404 naming it, while a project with no environments at all is a 400 about the project.
 * Collapsing them into `null` is how "environment not found" ends up reported as "project has no
 * environment", which sends the reader to the wrong place. */
export type CliEnvTarget =
	| { ok: true; id: string; name: string }
	| { ok: false; reason: "not-found"; requested: string }
	| { ok: false; reason: "no-environments" };

/**
 * Resolves the environment an env-scoped CLI **write** targets: the `?env=` value when the caller
 * gave one, otherwise the project's default.
 *
 * Extracted because every env-scoped write repeats it, and the repetition is what let the component
 * routes silently skip it — they hard-coded `resolveDefaultEnvironmentId`, so the CLI could only
 * ever author into the default environment. That made a two-environment project unreachable from the
 * terminal: `project_repositories` is UNIQUE `(project_id, environment_id)` with a per-env
 * `apps_path`, so a dev/staging pair pointing at different overlays — the whole shape of the
 * enterprise demo — could not be expressed.
 */
export async function resolveCliWriteEnvironment(
	projectId: string,
	envParam: string | null | undefined,
): Promise<CliEnvTarget> {
	if (envParam) {
		const env = await resolveCliEnvironment(projectId, envParam);
		return env
			? { ok: true, id: env.id, name: env.name }
			: { ok: false, reason: "not-found", requested: envParam };
	}
	const id = await resolveDefaultEnvironmentId(projectId);
	return id ? { ok: true, id, name: "" } : { ok: false, reason: "no-environments" };
}

/**
 * Resolves an environment within a project addressed by id, name, OR stage. Prefers the
 * `is_default` environment when a stage matches more than one. Returns the row or null.
 * Used by env-scoped CLI read routes (drift, cost, status, …) so a caller can pass
 * `--env production` (name/stage) or an environment id interchangeably.
 */
export async function resolveCliEnvironment(projectId: string, idOrName: string) {
	const matchers = [eq(projectEnvironments.name, idOrName)];
	if (isEnvironmentStage(idOrName)) {
		matchers.push(eq(projectEnvironments.stage, idOrName));
	}
	if (UUID_RE.test(idOrName)) matchers.unshift(eq(projectEnvironments.id, idOrName));

	const [row] = await getServiceDb()
		.select({
			id: projectEnvironments.id,
			name: projectEnvironments.name,
			stage: projectEnvironments.stage,
		})
		.from(projectEnvironments)
		.where(and(eq(projectEnvironments.project_id, projectId), or(...matchers)))
		.orderBy(desc(projectEnvironments.is_default))
		.limit(1);
	return row ?? null;
}
