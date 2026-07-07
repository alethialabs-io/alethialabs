// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { authorizeCli } from "@/lib/authz/guard";
import { resolveCliProject } from "@/lib/cli/resolve-project";
import { getServiceDb } from "@/lib/db";
import { projectEnvironments } from "@/lib/db/schema";
import { environmentStage } from "@/lib/db/schema/enums";
import { slugify } from "@/lib/slug";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import {
	cliEnvironmentResponse,
	cliEnvironmentsResponse,
} from "@/lib/validations/cli-contract";

/** Body of POST /api/cli/projects/:id/environments — add an environment. */
const addEnvironmentBody = z.object({
	name: z.string().min(1),
	stage: z.enum(environmentStage.enumValues).default("development"),
	region: z.string().min(1).optional(),
});

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
