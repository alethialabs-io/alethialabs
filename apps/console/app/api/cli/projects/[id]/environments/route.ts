// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { authorizeCli } from "@/lib/authz/guard";
import { resolveCliProject } from "@/lib/cli/resolve-project";
import { getServiceDb } from "@/lib/db";
import { projectEnvironments, projectFabrics } from "@/lib/db/schema";
import {
	environmentLifecycle,
	environmentStage,
	placementMode,
} from "@/lib/db/schema/enums";
import { slugify } from "@/lib/slug";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import {
	cliEnvironmentResponse,
	cliEnvironmentsResponse,
} from "@/lib/validations/cli-contract";

/** Body of POST /api/cli/projects/:id/environments — add an environment.
 *
 * `placement_mode` and its companions are the fix for a silent cost bomb. This route inserted with
 * `fabric_id` unset, and `project_environments.placement_mode` defaults to `dedicated` — so
 * `project env add staging` did not fail, it quietly became a WHOLE NEW CLUSTER with its own tofu
 * state key. The isolation ladder the product leads with (namespace → vcluster → dedicated) was
 * unreachable from the CLI, and the cheap rungs are the interesting ones. */
const addEnvironmentBody = z.object({
	name: z.string().min(1),
	stage: z.enum(environmentStage.enumValues).default("development"),
	region: z.string().min(1).optional(),
	/** Defaults to `namespace`: an environment ADDED to an existing project is the cheap-rung case,
	 *  and the expensive one should be the word you typed rather than the one you got. */
	placement_mode: z.enum(placementMode.enumValues).default("namespace"),
	/** The Fabric to place onto, by name. Ignored for `dedicated` (which owns a new Fabric).
	 *  Defaults to the project's default Fabric — "the second tier is free" only works if a shared
	 *  placement lands on the Fabric that already exists. */
	fabric: z.string().min(1).optional(),
	/** ArgoCD destination namespace for a shared placement. NULL → derived from the env name. */
	namespace: z
		.string()
		.max(63)
		.regex(/^[a-z][a-z0-9-]*$/, "Namespace must be a DNS-1123 label.")
		.optional(),
	lifecycle: z.enum(environmentLifecycle.enumValues).optional(),
});

/** A Fabric in this project, by name. `(project_id, name)` is unique, so at most one. */
async function findFabricByName(
	db: ReturnType<typeof getServiceDb>,
	projectId: string,
	name: string,
): Promise<string | null> {
	const [row] = await db
		.select({ id: projectFabrics.id })
		.from(projectFabrics)
		.where(
			and(eq(projectFabrics.project_id, projectId), eq(projectFabrics.name, name)),
		)
		.limit(1);
	return row?.id ?? null;
}

/**
 * The Fabric a shared placement lands on when the caller names none.
 *
 * `project_fabrics` has NO `is_default` column — the default Fabric is the one the project's DEFAULT
 * ENVIRONMENT is placed on, which is also the Fabric that owns a cluster. Falls back to the project's
 * earliest Fabric if the default env somehow carries no `fabric_id`.
 */
async function findDefaultFabric(
	db: ReturnType<typeof getServiceDb>,
	projectId: string,
): Promise<string | null> {
	const [defaultEnv] = await db
		.select({ fabric_id: projectEnvironments.fabric_id })
		.from(projectEnvironments)
		.where(eq(projectEnvironments.project_id, projectId))
		.orderBy(desc(projectEnvironments.is_default), projectEnvironments.created_at)
		.limit(1);
	if (defaultEnv?.fabric_id) return defaultEnv.fabric_id;

	const [earliest] = await db
		.select({ id: projectFabrics.id })
		.from(projectFabrics)
		.where(eq(projectFabrics.project_id, projectId))
		.orderBy(projectFabrics.created_at)
		.limit(1);
	return earliest?.id ?? null;
}

/** Maps an environment row to its CLI wire shape. */
function toEnvironmentWire(row: typeof projectEnvironments.$inferSelect) {
	return {
		id: row.id,
		name: row.name,
		stage: row.stage,
		status: row.status,
		is_default: row.is_default,
		region: row.region,
	};
}

/** Lists a project's environments (default first, then by creation). */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	try {
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}

		const rows = await getServiceDb()
			.select()
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, project.id))
			.orderBy(desc(projectEnvironments.is_default), projectEnvironments.created_at);

		return cliJson(cliEnvironmentsResponse, {
			environments: rows.map(toEnvironmentWire),
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

/** Adds a non-default environment to a project (name slugified; region inherits the project). */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "edit", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	const parsed = addEnvironmentBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
	}
	const name = slugify(parsed.data.name);
	if (!name) {
		return NextResponse.json(
			{ error: "Environment name is required" },
			{ status: 400 },
		);
	}

	try {
		const db = getServiceDb();
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}

		// Resolve the Fabric to place onto. `dedicated` owns a new Fabric, so it takes none here (the
		// provisioner creates it); a shared placement MUST land on an existing one, defaulting to the
		// project's default Fabric — which is what makes a second tier free rather than a second cluster.
		let fabricId: string | null = null;
		const mode = parsed.data.placement_mode;
		if (mode !== "dedicated") {
			const fabricName = parsed.data.fabric;
			fabricId = fabricName
				? await findFabricByName(db, project.id, fabricName)
				: await findDefaultFabric(db, project.id);
			if (!fabricId) {
				return NextResponse.json(
					{
						error: fabricName
							? `Fabric "${fabricName}" not found in this project`
							: "Project has no Fabric to place this environment onto",
					},
					{ status: fabricName ? 404 : 400 },
				);
			}
		}

		const [row] = await db
			.insert(projectEnvironments)
			.values({
				project_id: project.id,
				user_id: actor.userId,
				org_id: actor.orgId,
				name,
				stage: parsed.data.stage,
				status: "DRAFT",
				is_default: false,
				region: parsed.data.region ?? null,
				fabric_id: fabricId,
				placement_mode: mode,
				namespace: parsed.data.namespace ?? null,
				...(parsed.data.lifecycle ? { lifecycle: parsed.data.lifecycle } : {}),
			})
			.returning();

		return cliJson(
			cliEnvironmentResponse,
			{ environment: toEnvironmentWire(row) },
			{ status: 201 },
		);
	} catch (err: unknown) {
		// Duplicate env name for this project (project_id, name unique) → clear 400.
		const message = err instanceof Error ? err.message : "Internal Server Error";
		const status =
			typeof err === "object" && err !== null && "code" in err && err.code === "23505"
				? 400
				: 500;
		return NextResponse.json(
			{ error: status === 400 ? `Environment "${name}" already exists` : message },
			{ status },
		);
	}
}
