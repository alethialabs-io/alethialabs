// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { personalIdentityAuthor } from "@/lib/authz/actor-credential";
import { authorizeCli } from "@/lib/authz/guard";
import { CloudNotOfferedError } from "@/lib/cloud-providers/availability";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities } from "@/lib/db/schema";
import { actorIdentityWhere } from "@/lib/runners/claim-identity";
import { insertProjectWithDefaultFabric } from "@/lib/queries/projects";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import {
	insertCreateTimeClusters,
	NoDedicatedEnvironmentError,
	type CreateClusterShape,
} from "@/lib/cli/create-cluster-shape";
import {
	cliProjectResponse,
} from "@/lib/validations/cli-contract";
import { createProjectBody } from "@/lib/validations/cli-request-bodies";

/** The node shape a parsed body asked for, or `null` when it named none — the only case in which
 * this route writes no cluster row. */
function requestedShape(body: z.infer<typeof createProjectBody>): CreateClusterShape | null {
	if (body.instance_type !== undefined) return { instance_type: body.instance_type };
	if (body.node_size !== undefined) return { node_size: body.node_size };
	return null;
}

/**
 * Creates a project scoped to the active org via the shared front-door core
 * ({@link insertProjectWithDefaultFabric}): the project row, its default Fabric, the
 * Production (dedicated) + Preview (namespace) environments, and the project → org authz
 * hierarchy edge so org-wide grants flow down. Identical shape to a console-created project;
 * components are added afterwards via `project component add` (this route skips the
 * form-driven component seeding the createProject server action does).
 */
export async function POST(req: Request) {
	const auth = await authorizeCli(req, "create", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	const parsed = createProjectBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		// The node-shape refusals and the environment-matrix refusals (a reserved or shared placement
		// namespace, #6551; a name the console would shadow) carry a sentence the caller can act on;
		// every other failure keeps the generic message, as before.
		const shapeRefusal = parsed.error.issues.find(
			(i) =>
				i.code === "custom" &&
				(i.path[0] === "node_size" || i.path[0] === "instance_type"),
		);
		const envRefusal = parsed.error.issues.find(
			(i) => i.code === "custom" && i.path[0] === "environments",
		);
		return NextResponse.json(
			{
				error:
					shapeRefusal?.message ??
					(envRefusal ? `${envRefusal.path.join(".")}: ${envRefusal.message}` : "Invalid request body"),
			},
			{ status: 400 },
		);
	}
	const body = parsed.data;
	const shape = requestedShape(body);

	try {
		const db = getServiceDb();

		// Resolve the cloud provider (for the wire) + verify the identity belongs to the org.
		let cloudProvider = "";
		if (body.cloud_identity_id) {
			const [ci] = await db
				.select({ id: cloudIdentities.id, provider: cloudIdentities.provider })
				.from(cloudIdentities)
				// By id AND the identity RLS policy's tenancy (#5479, #5481): an `org` identity of
				// this org, or — for a session — the caller's own `personal` one. Matching `org_id`
				// alone admitted another member's personal identity, which carries the org it was
				// created in.
				.where(
					actorIdentityWhere(
						body.cloud_identity_id,
						actor.orgId,
						personalIdentityAuthor(actor),
					),
				)
				.limit(1);
			if (!ci) {
				return NextResponse.json(
					{ error: "Cloud identity not found" },
					{ status: 400 },
				);
			}
			cloudProvider = ci.provider;
		}

		// One transaction over the shared front-door core: project + default Fabric + Prod(dedicated)
		// /Preview(namespace) envs + project→org edge — the SAME invariant the console createProject
		// server action applies, so a CLI-created project has the identical shape. A mid-sequence
		// failure now rolls the whole thing back instead of orphaning a project.
		const { project } = await db.transaction(async (tx) => {
			const created = await insertProjectWithDefaultFabric(tx, {
				project_name: body.project_name,
				region: body.region,
				cloud_identity_id: body.cloud_identity_id ?? null,
				iac_version: body.iac_version,
				environment_stage: body.stage,
				// Both optional and both ignored when absent, so a caller that sends neither gets the
				// byte-identical legacy Prod(dedicated)+Preview(namespace) shape.
				placement_mode: body.placement_mode,
				environments: body.environments,
				owner: actor.userId,
				orgId: actor.orgId,
			});
			// The node shape, when one was asked for, becomes an explicit cluster row on each
			// dedicated environment — in the SAME transaction, so a refusal rolls the project back
			// rather than leaving one created without the shape the caller asked for. With no shape
			// nothing is written, exactly as before: the template default (= the catalog default)
			// applies, and no default is ever stamped onto a row here.
			if (shape) await insertCreateTimeClusters(tx, created.project.id, shape);
			return created;
		});

		return cliJson(
			cliProjectResponse,
			{
				project: {
					id: project.id,
					project_name: project.project_name,
					slug: project.slug ?? "",
					region: project.region,
					iac_version: project.iac_version,
					cloud_identity_id: project.cloud_identity_id,
					cloud_provider: cloudProvider,
					environment_stage: body.stage,
					status: "DRAFT",
					estimated_monthly_cost: project.estimated_monthly_cost,
					created_at: project.created_at.toISOString(),
					updated_at: project.updated_at.toISOString(),
				},
			},
			{ status: 201 },
		);
	} catch (err: unknown) {
		if (err instanceof NoDedicatedEnvironmentError) {
			return NextResponse.json({ error: err.message }, { status: 400 });
		}
		// The cloud identity is on a cloud this deployment does not offer (#6811), refused before
		// anything was written. The caller's request conflicts with the deployment's offered set; it
		// was a 500 carrying this sentence until #6964.
		if (err instanceof CloudNotOfferedError) {
			return NextResponse.json(
				{ error: err.message, code: "cloud_not_offered" },
				{ status: 409 },
			);
		}
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
