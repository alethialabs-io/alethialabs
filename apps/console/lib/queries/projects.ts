// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { mirrorHierarchyEdge } from "@/lib/authz/tuple-sync";
import {
	type EnvironmentLifecycle,
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

/** One environment the front door seeds, with its placement onto a Fabric. The placement selector
 * (#844) emits these; the fan-out below turns them into `project_fabrics` + `project_environments`
 * rows (a Fabric per `dedicated` env, one shared Fabric for all `namespace`/`vcluster` envs). */
export interface EnvironmentSpec {
	/** Slug-safe env name — also the Fabric name for a `dedicated` env and the tofu state segment. */
	name: string;
	stage: EnvironmentStage;
	placement_mode: PlacementMode;
	/** `persistent` (default) or `ephemeral` (e.g. preview). Data-only seam until the reaper reads it. */
	lifecycle?: EnvironmentLifecycle;
	/** ArgoCD destination namespace for a shared placement; ignored for `dedicated`. */
	namespace?: string | null;
	/** Exactly one spec must be the default — the representative env for single-value surfaces. */
	is_default?: boolean;
}

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
	 *  cluster owner). Preview is always `namespace` on that same Fabric. Ignored when `environments`
	 *  is provided (the full matrix carries its own placements). */
	placement_mode?: PlacementMode;
	/** The full environment matrix from the placement selector (#844). When present, the core fans it
	 *  out into a Fabric per `dedicated` env + one shared Fabric for the `namespace`/`vcluster` envs.
	 *  When ABSENT the core keeps the legacy Prod(dedicated)+Preview(namespace-on-Prod-Fabric) shape
	 *  — so the CLI route and any caller that doesn't set it are byte-identical to before. */
	environments?: EnvironmentSpec[];
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

	// The Fabric(s) are the front door's infra units. Project-level region/cloud stay populated for
	// compatibility while downstream reads move to Fabric. Common per-Fabric values:
	const fabricBase = {
		project_id: project.id,
		user_id: input.owner,
		org_id: project.org_id,
		cloud_identity_id: input.cloud_identity_id ?? null,
		region: input.region,
		status: "DRAFT" as const,
	};

	let defaultFabric: { id: string };
	let defaultEnv: { id: string };
	let previewEnv: { id: string };

	if (input.environments && input.environments.length > 0) {
		// --- Fan-out: the full environment matrix from the placement selector (#844) ---------------
		// Placement model: a `dedicated` env OWNS its Fabric 1:1; every `namespace`/`vcluster` env
		// shares ONE Fabric. Everything is `DRAFT` — no cluster is provisioned until a deploy.
		const specs = input.environments;
		// Bound the fan-out HERE, not just in the form schema — createProject doesn't re-parse the
		// client input, so the core is the real choke point against a crafted many-env request.
		if (specs.length > 8) {
			throw new Error("Too many environments (max 8).");
		}
		const defaults = specs.filter((s) => s.is_default);
		if (defaults.length !== 1) {
			throw new Error("Exactly one environment must be the default.");
		}
		// Slug-safe names (DNS-1123 label): the env name feeds the tofu state-path segment and the
		// Fabric name — validated HERE because createProject does not re-parse the client input, so a
		// crafted request must not smuggle path separators into a storage key.
		const SLUG_LABEL = /^[a-z][a-z0-9-]{0,39}$/;
		for (const s of specs) {
			if (!SLUG_LABEL.test(s.name)) {
				throw new Error(`Invalid environment name "${s.name}".`);
			}
			if (s.namespace != null && !/^[a-z][a-z0-9-]{0,62}$/.test(s.namespace)) {
				throw new Error(`Invalid namespace "${s.namespace}".`);
			}
		}
		const SHARED_FABRIC = "shared";
		if (specs.some((s) => s.name === SHARED_FABRIC)) {
			throw new Error(`"${SHARED_FABRIC}" is a reserved environment name.`);
		}
		// Unique env names — mirrors the (project_id, name) constraint so the env→Fabric map is 1:1.
		if (new Set(specs.map((s) => s.name)).size !== specs.length) {
			throw new Error("Environment names must be unique.");
		}
		const hasShared = specs.some((s) => s.placement_mode !== "dedicated");

		// One Fabric per dedicated env + a single shared Fabric when any env is namespace/vcluster.
		const fabricRows = await tx
			.insert(projectFabrics)
			.values([
				...specs
					.filter((s) => s.placement_mode === "dedicated")
					.map((s) => ({ ...fabricBase, name: s.name })),
				...(hasShared ? [{ ...fabricBase, name: SHARED_FABRIC }] : []),
			])
			.returning({ id: projectFabrics.id, name: projectFabrics.name });
		const fabricByName = new Map(fabricRows.map((f) => [f.name, f.id]));
		/** The Fabric a spec is placed on: its own (dedicated) or the shared one. */
		const fabricFor = (s: EnvironmentSpec): string => {
			const id =
				s.placement_mode === "dedicated"
					? fabricByName.get(s.name)
					: fabricByName.get(SHARED_FABRIC);
			if (!id) throw new Error(`No Fabric for environment "${s.name}".`);
			return id;
		};

		const envRows = await tx
			.insert(projectEnvironments)
			.values(
				specs.map((s) => ({
					project_id: project.id,
					user_id: input.owner,
					org_id: project.org_id,
					name: s.name,
					stage: s.stage,
					status: "DRAFT" as const,
					is_default: s.is_default ?? false,
					region: input.region,
					fabric_id: fabricFor(s),
					placement_mode: s.placement_mode,
					// `dedicated` owns the whole Fabric → no namespace; shared placements carry one.
					namespace: s.placement_mode === "dedicated" ? null : (s.namespace ?? null),
					lifecycle: s.lifecycle ?? "persistent",
				})),
			)
			.returning({
				id: projectEnvironments.id,
				name: projectEnvironments.name,
				is_default: projectEnvironments.is_default,
			});

		const def = envRows.find((e) => e.is_default);
		if (!def) throw new Error("Failed to create the default environment.");
		defaultEnv = { id: def.id };
		// `previewEnv` is retained for the result contract; fall back to the default if none is named.
		previewEnv = { id: (envRows.find((e) => e.name === "preview") ?? def).id };
		defaultFabric = { id: fabricFor(defaults[0]) };
	} else {
		// --- Legacy shape (unchanged): one Fabric named after the stage; Prod(dedicated) + Preview
		// (namespace) BOTH placed on it. Byte-identical to the #900 seam so the CLI route and any
		// caller that doesn't set `environments` don't drift.
		const [fabric] = await tx
			.insert(projectFabrics)
			.values({ ...fabricBase, name: input.environment_stage })
			.returning({ id: projectFabrics.id });
		if (!fabric) throw new Error("Failed to create default Fabric");

		const [dEnv, pEnv] = await tx
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
					fabric_id: fabric.id,
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
					fabric_id: fabric.id,
					placement_mode: "namespace",
					namespace: "preview",
				},
			])
			.returning({ id: projectEnvironments.id });
		if (!dEnv || !pEnv)
			throw new Error("Failed to create project environments");
		defaultFabric = fabric;
		defaultEnv = dEnv;
		previewEnv = pEnv;
	}

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
