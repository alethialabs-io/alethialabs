// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import {
	deleteProjectComponent,
	getKindDef,
	isSingletonKind,
} from "@/lib/cli/project-components";
import { resolveCliProject } from "@/lib/cli/resolve-project";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliOkResponse } from "@/lib/validations/cli-contract";

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
		const removed = await deleteProjectComponent(kind, project.id, name);
		if (!removed) {
			return NextResponse.json({ error: "Component not found" }, { status: 404 });
		}
		return cliJson(cliOkResponse, { ok: true });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
