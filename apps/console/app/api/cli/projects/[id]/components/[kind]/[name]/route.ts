// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { authorizeCli, userIdIsTheCaller } from "@/lib/authz/guard";
import {
	ComponentWriteRefusedError,
	componentIdentityAllowed,
	componentWriteRefusedBody,
	deleteProjectComponent,
	getKindDef,
	isSingletonKind,
	parseIfMatch,
	updateProjectComponent,
	validateComponentFields,
} from "@/lib/cli/project-components";
import {
	resolveCliProject,
	resolveCliWriteEnvironment,
} from "@/lib/cli/resolve-project";
import { NextResponse } from "next/server";
import { cliEnvironmentError, cliJson } from "@/lib/cli/respond";
import {
	cliComponentConflictResponse,
	cliComponentResponse,
	cliOkResponse,
} from "@/lib/validations/cli-contract";

/** Body of PATCH .../components/:kind/:name — the fields to change, and nothing else. `strict` so a
 * `name` (a rename) or any other key is a 400 rather than silently ignored. */
const updateComponentBody = z
	.object({ fields: z.record(z.string(), z.unknown()) })
	.strict();

/** Updates the settable fields of a named (multi) component in one environment — what `alethia
 * apply` calls for a component whose declared fields differ from the server's. Same authorization,
 * org binding and environment resolution as POST .../components/:kind, and the same field
 * validation, so "settable" means one thing for both writes. Only the fields sent are changed.
 *
 * Two refusals, both 409 (#5551): `component_busy` — a DEPLOY or DESTROY job of the environment is
 * queued or running; `component_changed` — the request sent `If-Match: <revision>` (the `updated_at`
 * the caller read) and the row is no longer at it. Without `If-Match` only the first applies. */
export async function PATCH(
	req: Request,
	{ params }: { params: Promise<{ id: string; kind: string; name: string }> },
) {
	const auth = await authorizeCli(req, "edit", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id, kind, name } = await params;

	if (!getKindDef(kind)) {
		return NextResponse.json(
			{ error: `Unknown component kind "${kind}"` },
			{ status: 400 },
		);
	}
	if (isSingletonKind(kind)) {
		return NextResponse.json(
			{ error: `${kind} is a singleton — update it with add (it upserts), without a name` },
			{ status: 400 },
		);
	}

	const parsed = updateComponentBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Invalid request body: expected {\"fields\": {…}}" },
			{ status: 400 },
		);
	}
	const { fields } = parsed.data;
	if (Object.keys(fields).length === 0) {
		return NextResponse.json(
			{ error: "No fields to update — send at least one field" },
			{ status: 400 },
		);
	}
	const validated = validateComponentFields(kind, fields);
	if (!validated.ok) {
		return NextResponse.json({ error: validated.error }, { status: 400 });
	}
	const precondition = parseIfMatch(req.headers.get("if-match"));
	if (!precondition.ok) {
		return NextResponse.json({ error: precondition.error }, { status: 400 });
	}

	try {
		// The org binding: a project is resolved only inside the caller's org, so a project id from
		// another tenant is a 404 here exactly as it is for POST and DELETE.
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}
		const target = await resolveCliWriteEnvironment(
			project.id,
			new URL(req.url).searchParams.get("env"),
		);
		if (!target.ok) return cliEnvironmentError(target);
		// The identity is bound to the caller's org like the project is: a foreign one is "not
		// found", exactly as a foreign project id is.
		if (
			!(await componentIdentityAllowed(
				validated.values,
				actor.orgId,
				userIdIsTheCaller(auth.credential) ? actor.userId : undefined,
			))
		) {
			return NextResponse.json({ error: "Cloud identity not found" }, { status: 404 });
		}
		const component = await updateProjectComponent(
			kind,
			project.id,
			target.id,
			name,
			validated.values,
			{ ifMatch: precondition.ifMatch },
		);
		if (!component) {
			return NextResponse.json({ error: "Component not found" }, { status: 404 });
		}
		return cliJson(cliComponentResponse, { component });
	} catch (err: unknown) {
		if (err instanceof ComponentWriteRefusedError) {
			return cliJson(cliComponentConflictResponse, componentWriteRefusedBody(err), { status: 409 });
		}
		// A constraint the column itself enforces (NOT NULL, CHECK, FK) is the caller's value, not a
		// server fault — the same mapping POST makes.
		if (typeof err === "object" && err !== null && "code" in err) {
			const code = err.code;
			if (code === "23502" || code === "23514" || code === "23503") {
				const message = err instanceof Error ? err.message : "Invalid component fields";
				return NextResponse.json({ error: message }, { status: 400 });
			}
		}
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

/** Deletes a named (multi) component from a project — databases/caches/queues/topics/
 * nosql_tables/container_registries/secrets/storage_buckets. */
export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string; kind: string; name: string }> },
) {
	const auth = await authorizeCli(req, "edit", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id, kind, name } = await params;

	if (!getKindDef(kind)) {
		return NextResponse.json(
			{ error: `Unknown component kind "${kind}"` },
			{ status: 400 },
		);
	}
	if (isSingletonKind(kind)) {
		return NextResponse.json(
			{ error: `${kind} is a singleton — remove it without a name` },
			{ status: 400 },
		);
	}

	try {
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}
		// `?env=` scopes the delete to one environment; without it, the project's default. A named
		// component exists once PER environment (UNIQUE project_id, environment_id, name), so an
		// unscoped delete would remove the sibling environment's row too.
		const target = await resolveCliWriteEnvironment(
			project.id,
			new URL(req.url).searchParams.get("env"),
		);
		if (!target.ok) return cliEnvironmentError(target);
		const removed = await deleteProjectComponent(
			kind,
			project.id,
			name,
			target.id,
		);
		if (!removed) {
			return NextResponse.json({ error: "Component not found" }, { status: 404 });
		}
		return cliJson(cliOkResponse, { ok: true });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
