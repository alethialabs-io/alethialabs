// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import {
	getKindDef,
	listProjectComponents,
} from "@/lib/cli/project-components";
import { resolveCliProject } from "@/lib/cli/resolve-project";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliComponentsResponse } from "@/lib/validations/cli-contract";

/**
 * Lists a project's components — all kinds, or filtered by `?kind=`. The `?env=` filter is
 * accepted for forward-compatibility but is a no-op today: components are project-scoped,
 * not per-environment, in the current schema.
 */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	const url = new URL(req.url);
	const kind = url.searchParams.get("kind") ?? undefined;
	if (kind && !getKindDef(kind)) {
		return NextResponse.json(
			{ error: `Unknown component kind "${kind}"` },
			{ status: 400 },
		);
	}

	try {
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}
		const components = await listProjectComponents(project.id, kind);
		return cliJson(cliComponentsResponse, { components });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
