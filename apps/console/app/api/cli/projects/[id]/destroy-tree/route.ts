// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/projects/:id/destroy-tree[?env=<id|name>] — what destroying an environment destroys
// (#5249): the environment plus every live environment placed on the Fabric it owns, tenants first
// and the owner last. `alethia project destroy --cascade` prints this and confirms BEFORE it queues,
// so the operator sees every environment the cascade will take with it.
//
// A read, so it is authorized as `view`; the destroy itself is authorized as `destroy` by
// destroyProject when POST /api/jobs queues it.

import { NextResponse } from "next/server";
import { getDestroyTree } from "@/app/server/actions/projects";
import { runWithActor } from "@/lib/authz/actor-context";
import { authorizeCli } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { resolveCliProject, resolveCliWriteEnvironment } from "@/lib/cli/resolve-project";
import { cliEnvironmentError, cliJson } from "@/lib/cli/respond";
import { cliDestroyTreeResponse } from "@/lib/validations/cli-contract";

/** Returns the destroy tree of the project's `?env=` environment (default: its default env). */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	try {
		// Org-scoped: a project of another org is "not found", never a different tenant's tree.
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}
		const target = await resolveCliWriteEnvironment(
			project.id,
			new URL(req.url).searchParams.get("env"),
		);
		if (!target.ok) return cliEnvironmentError(target);

		// The action authorizes `view` on THIS project through the PDP, under the CLI caller.
		const { tree } = await runWithActor(actor, () =>
			getDestroyTree(project.id, target.id),
		);
		return cliJson(cliDestroyTreeResponse, { tree });
	} catch (err: unknown) {
		if (err instanceof ForbiddenError) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
