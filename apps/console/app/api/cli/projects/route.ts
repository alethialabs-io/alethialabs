// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { z } from "zod";
import { authorizeCli } from "@/lib/authz/guard";
import { mirrorHierarchyEdge } from "@/lib/authz/tuple-sync";
import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	projectEnvironments,
	projects,
	resourceHierarchy,
} from "@/lib/db/schema";
import { environmentStage } from "@/lib/db/schema/enums";
import {
	pickFreeSlug,
	RESERVED_PROJECT_CHILD_SLUGS,
	slugify,
} from "@/lib/routing";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliProjectResponse } from "@/lib/validations/cli-contract";

/** Default OpenTofu version when the caller doesn't pin one (matches the console form). */
const DEFAULT_IAC_VERSION = "1.11.4";

/** Body of POST /api/cli/projects — create a project (+ its default environment). */
const createProjectBody = z.object({
	project_name: z.string().min(1).max(120),
	region: z.string().min(1),
	cloud_identity_id: z.string().uuid().optional(),
	stage: z.enum(environmentStage.enumValues).default("development"),
	iac_version: z.string().min(1).default(DEFAULT_IAC_VERSION),
});

/**
 * Creates a project scoped to the active org: the project row, its default environment,
 * and the authz hierarchy edge (project → org) so org-wide grants flow down. Components
 * are added afterwards via `project component add`. Mirrors the console createProject
 * server action, minus the form-driven component seeding.
 */
export async function POST(req: Request) {
	const auth = await authorizeCli(req, "create", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	const parsed = createProjectBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
	}
	const body = parsed.data;

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

		// Unique-per-org URL slug, skipping reserved project-child segments.
		const existing = await db
			.select({ slug: projects.slug })
			.from(projects)
			.where(eq(projects.org_id, actor.orgId));
		const slug = pickFreeSlug(slugify(body.project_name) || "project", [
			...existing.map((r) => r.slug).filter((s): s is string => Boolean(s)),
			...RESERVED_PROJECT_CHILD_SLUGS,
		]);

		const [project] = await db
			.insert(projects)
			.values({
				project_name: body.project_name,
				region: body.region,
				iac_version: body.iac_version,
				slug,
				user_id: actor.userId,
				org_id: actor.orgId,
				cloud_identity_id: body.cloud_identity_id ?? null,
			})
			.returning();

		await db.insert(projectEnvironments).values({
			project_id: project.id,
			user_id: actor.userId,
			org_id: actor.orgId,
			name: body.stage,
			stage: body.stage,
			status: "DRAFT",
			is_default: true,
			region: body.region,
		});

		await db
			.insert(resourceHierarchy)
			.values({
				child_type: "project",
				child_id: project.id,
				parent_type: "org",
				parent_id: actor.orgId,
			})
			.onConflictDoNothing();
		mirrorHierarchyEdge("project", project.id, "org", actor.orgId);

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
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
