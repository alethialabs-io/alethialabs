// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { mirrorHierarchyEdge } from "@/lib/authz/tuple-sync";
import {
	type EnvironmentStage,
	type PlacementMode,
	type Project,
	projectEnvironments,
	projectFabrics,
	projects,
	resourceHierarchy,
} from "@/lib/db/schema";
import {
	pickFreeSlug,
	RESERVED_PROJECT_CHILD_SLUGS,
	slugify,
} from "@/lib/routing";

/** Scalar inputs the create front door needs — the `project` sub-object of `CreateProjectInput`
 * plus the resolved tenancy (owner + active org). Deliberately narrow: the shared core owns the
 * Fabric + placement invariant, not the form's component graph. */
export interface CreateProjectCoreInput {
	project_name: string;
	region: string;
	cloud_identity_id?: string | null;
	iac_version: string;
	/** Seeds the default Fabric's name AND the default (Production) environment's name + stage. */
	environment_stage: EnvironmentStage;
	/** The default (Production) environment's placement onto its first Fabric. Optional so the value
	 *  flows from the create front door (UI #844 / CLI) rather than a literal; defaults to `dedicated`
	 *  — a new project's first env OWNS the Fabric it provisions, so `dedicated` is the sensible
	 *  default (placing the first env as `namespace`/`vcluster` would leave the new Fabric with no
	 *  cluster owner). Preview is always `namespace` on that same Fabric. */
	placement_mode?: PlacementMode;
	/** The creating user id — stamped on every row. */
	owner: string;
	/** The ACTIVE ORG id — rows belong to the org, not the creating user (they diverge under EE). */
	orgId: string;
}

/** The rows the front door always creates, returned so callers can seed components onto the default
 * env / render a wire response. */
export interface CreateProjectCoreResult {
	project: Project;
	defaultFabric: { id: string };
	defaultEnv: { id: string };
	previewEnv: { id: string };
}

/**
 * The project-creation front door's shared core: inserts the project row, its default **Fabric**,
 * the **Production + Preview** environments with explicit placement (Prod = `dedicated` on the new
 * Fabric; Preview = `namespace` on that same Fabric), and the project→org authz hierarchy edge.
 *
 * This is the single owner of the "default Fabric + Prod/Preview placement" invariant, called by
 * BOTH the `createProject` server action (canvas/form path) and the `POST /api/cli/projects` route
 * (CLI path) so the two can never drift. Runs entirely inside the caller-provided transaction `tx`
 * — the caller owns auth + tenancy resolution (RLS `withScope` for the action; a service-role
 * `transaction` for the CLI route) and any post-insert work (components, audit, wire response).
 *
 * The org-scoped slug select filters `org_id` EXPLICITLY so it is correct under a service-role
 * (BYPASSRLS) transaction as well as an RLS-scoped one — never rely on RLS alone for uniqueness here.
 */
export async function insertProjectWithDefaultFabric(
	tx: Tx,
	input: CreateProjectCoreInput,
): Promise<CreateProjectCoreResult> {
	// Unique-per-org URL slug, skipping reserved project-child segments (e.g. "settings") so a
	// project slug can never shadow a project-scoped route.
	const existing = await tx
		.select({ slug: projects.slug })
		.from(projects)
		.where(eq(projects.org_id, input.orgId));
	const slug = pickFreeSlug(slugify(input.project_name) || "project", [
		...existing.map((r) => r.slug).filter((s): s is string => Boolean(s)),
		...RESERVED_PROJECT_CHILD_SLUGS,
	]);

	const [project] = await tx
		.insert(projects)
		.values({
			project_name: input.project_name,
			region: input.region,
			iac_version: input.iac_version,
			cloud_identity_id: input.cloud_identity_id ?? null,
			slug,
			user_id: input.owner,
			org_id: input.orgId,
		})
		.returning();
	if (!project) throw new Error("Failed to create project");

	// The first Fabric is the front door's infra unit. Project-level region/cloud stay populated for
	// compatibility while downstream reads move to Fabric.
	const [defaultFabric] = await tx
		.insert(projectFabrics)
		.values({
			project_id: project.id,
			user_id: input.owner,
			org_id: project.org_id,
			name: input.environment_stage,
			cloud_identity_id: input.cloud_identity_id ?? null,
			region: input.region,
			status: "DRAFT",
		})
		.returning({ id: projectFabrics.id });
	if (!defaultFabric) throw new Error("Failed to create default Fabric");

	// Project creation owns the Production + Preview invariant: the default env's placement comes from
	// the input (defaulting to `dedicated` — the new Fabric's owner); Preview is namespace-placed on
	// that same Fabric.
	const [defaultEnv, previewEnv] = await tx
		.insert(projectEnvironments)
		.values([
			{
				project_id: project.id,
				user_id: input.owner,
				org_id: project.org_id,
				name: input.environment_stage,
				stage: input.environment_stage,
				status: "DRAFT",
				is_default: true,
				region: input.region,
				fabric_id: defaultFabric.id,
				placement_mode: input.placement_mode ?? "dedicated",
			},
			{
				project_id: project.id,
				user_id: input.owner,
				org_id: project.org_id,
				name: "preview",
				stage: "development",
				status: "DRAFT",
				is_default: false,
				region: input.region,
				fabric_id: defaultFabric.id,
				placement_mode: "namespace",
				namespace: "preview",
			},
		])
		.returning({ id: projectEnvironments.id });
	if (!defaultEnv || !previewEnv)
		throw new Error("Failed to create project environments");

	// Authz hierarchy edge: project → org, so an org-wide grant flows down to this project.
	await tx
		.insert(resourceHierarchy)
		.values({
			child_type: "project",
			child_id: project.id,
			parent_type: "org",
			parent_id: input.orgId,
		})
		.onConflictDoNothing();
	mirrorHierarchyEdge("project", project.id, "org", input.orgId);

	return { project, defaultFabric, defaultEnv, previewEnv };
}
