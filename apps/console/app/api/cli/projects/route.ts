// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { z } from "zod";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities } from "@/lib/db/schema";
import { environmentStage, placementMode } from "@/lib/db/schema/enums";
import { insertProjectWithDefaultFabric } from "@/lib/queries/projects";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import {
	insertCreateTimeClusters,
	NoDedicatedEnvironmentError,
	type CreateClusterShape,
} from "@/lib/cli/create-cluster-shape";
import {
	cliProjectNodeShapeRequest,
	cliProjectResponse,
} from "@/lib/validations/cli-contract";
import { environmentMatrixSchema } from "@/lib/validations/project-form.schema";

/** Default OpenTofu version when the caller doesn't pin one (matches the console form). */
const DEFAULT_IAC_VERSION = "1.11.4";

/** Body of POST /api/cli/projects — create a project (+ its default environment).
 *
 * `placement_mode` and `environments` were the two fields the CLI never sent, even though
 * `insertProjectWithDefaultFabric` has always accepted and validated them. The consequence was not a
 * missing feature but a cost one: with no matrix, EVERY environment the CLI created came out
 * `dedicated`, which is a cluster each. A four-cloud two-tier demo built from the terminal
 * provisioned eight clusters where the product's own placement story provisions four.
 *
 * `environments` reuses the console form's own validator (`environmentMatrixSchema`) rather than
 * restating it, so the shape the fan-out receives is the shape the fan-out was written against.
 *
 * `instance_type` / `node_size` (#5266) are the node shape, from the wire contract
 * (`cliProjectNodeShapeRequest`, which the Go client is strict-decoded against). They are mutually
 * exclusive: the Go resolver PREFERS `instance_types` over `node_size`, so a row carrying both would
 * provision the machine type and silently ignore the size the caller also asked for. A machine type
 * also needs a cloud, because it names one cloud's SKU — with no linked account there is nothing to
 * say it belongs to. */
const createProjectBody = z
	.object({
		project_name: z.string().min(1).max(120),
		region: z.string().min(1),
		cloud_identity_id: z.string().uuid().optional(),
		stage: z.enum(environmentStage.enumValues).default("development"),
		iac_version: z.string().min(1).default(DEFAULT_IAC_VERSION),
		placement_mode: z.enum(placementMode.enumValues).optional(),
		environments: environmentMatrixSchema.optional(),
		...cliProjectNodeShapeRequest.shape,
	})
	.superRefine((body, ctx) => {
		if (body.instance_type !== undefined && body.node_size !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["node_size"],
				message: "instance_type and node_size are mutually exclusive: pass one",
			});
		}
		if (body.instance_type !== undefined && body.cloud_identity_id === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["instance_type"],
				message:
					"instance_type names one cloud's machine type, so it needs cloud_identity_id; use node_size for a cloud-indifferent size",
			});
		}
	});

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
		// The two node-shape refusals carry a sentence the caller can act on ("pass one"); every other
		// failure keeps the generic message, as before.
		const refusal = parsed.error.issues.find(
			(i) =>
				i.code === "custom" &&
				(i.path[0] === "node_size" || i.path[0] === "instance_type"),
		);
		return NextResponse.json(
			{ error: refusal?.message ?? "Invalid request body" },
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
				.where(eq(cloudIdentities.id, body.cloud_identity_id))
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
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
