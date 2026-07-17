// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { authorizeCli } from "@/lib/authz/guard";
import {
	deleteProjectComponent,
	getKindDef,
	insertProjectComponent,
	isSingletonKind,
	validateComponentFields,
} from "@/lib/cli/project-components";
import {
	resolveCliProject,
	resolveDefaultEnvironmentId,
} from "@/lib/cli/resolve-project";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import {
	cliComponentResponse,
	cliOkResponse,
} from "@/lib/validations/cli-contract";

/** Body of POST .../components/:kind — `fields` is the open `--set` field map, validated
 * server-side against the kind's drizzle-zod insert schema. */
const addComponentBody = z.object({
	name: z.string().min(1).optional(),
	fields: z.record(z.string(), z.unknown()).default({}),
});

/** Adds (or, for singletons, upserts) a component of `kind` to a project. */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string; kind: string }> },
) {
	const auth = await authorizeCli(req, "edit", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id, kind } = await params;

	if (!getKindDef(kind)) {
		return NextResponse.json(
			{ error: `Unknown component kind "${kind}"` },
			{ status: 400 },
		);
	}

	const parsed = addComponentBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
	}
	const { name, fields } = parsed.data;
	const singleton = isSingletonKind(kind);
	if (!singleton && !name) {
		return NextResponse.json(
			{ error: `A --name is required for ${kind} components` },
			{ status: 400 },
		);
	}

	const validated = validateComponentFields(kind, fields);
	if (!validated.ok) {
		return NextResponse.json({ error: validated.error }, { status: 400 });
	}

	try {
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}
		const environmentId = await resolveDefaultEnvironmentId(project.id);
		if (!environmentId) {
			return NextResponse.json(
				{ error: "Project has no environment to add the component to" },
				{ status: 400 },
			);
		}
		const component = await insertProjectComponent(
			kind,
			project.id,
			environmentId,
			name ?? "",
			validated.values,
		);
		return cliJson(cliComponentResponse, { component }, { status: 201 });
	} catch (err: unknown) {
		return errorResponse(err, name ?? kind);
	}
}

/** Deletes a SINGLETON component (network/cluster/dns/observability/repositories). Multi
 * kinds are removed by name via .../components/:kind/:name. */
export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string; kind: string }> },
) {
	const auth = await authorizeCli(req, "edit", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id, kind } = await params;

	if (!getKindDef(kind)) {
		return NextResponse.json(
			{ error: `Unknown component kind "${kind}"` },
			{ status: 400 },
		);
	}
	if (!isSingletonKind(kind)) {
		return NextResponse.json(
			{ error: `${kind} components are removed by name (pass --name)` },
			{ status: 400 },
		);
	}

	try {
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}
		const removed = await deleteProjectComponent(kind, project.id, "");
		if (!removed) {
			return NextResponse.json({ error: "Component not found" }, { status: 404 });
		}
		return cliJson(cliOkResponse, { ok: true });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

/** Maps an insert error to a clear status: 409 on a duplicate-name conflict, 400 on other
 * constraint violations (e.g. a missing required column), else 500. */
function errorResponse(err: unknown, label: string): NextResponse {
	if (typeof err === "object" && err !== null && "code" in err) {
		const code = err.code;
		if (code === "23505") {
			return NextResponse.json(
				{ error: `Component "${label}" already exists` },
				{ status: 409 },
			);
		}
		if (code === "23502" || code === "23514" || code === "23503") {
			const message = err instanceof Error ? err.message : "Invalid component fields";
			return NextResponse.json({ error: message }, { status: 400 });
		}
	}
	const message = err instanceof Error ? err.message : "Internal Server Error";
	return NextResponse.json({ error: message }, { status: 500 });
}
