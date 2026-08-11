// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared plumbing for the BYO (bring-your-own chart / IaC) CLI WRITE routes. Both surfaces resolve
// the same scope and fail for the same set of reasons, so they resolve and translate it once here
// rather than twice with a chance of disagreeing about which status a refusal deserves.

import { NextResponse } from "next/server";
import {
	resolveCliProject,
	resolveCliWriteEnvironment,
} from "@/lib/cli/resolve-project";
import { cliEnvironmentError } from "@/lib/cli/respond";

/** A resolved (project, environment) pair, or the response that explains why it could not be. */
export type ByoScope =
	| { projectId: string; environmentId: string }
	| { error: NextResponse };

/**
 * Resolves the project and target environment a BYO write applies to: the project from the path
 * segment, scoped to the actor's org, and the environment from `?env=` or the project's default.
 */
export async function resolveByoScope(
	orgId: string,
	projectRef: string,
	req: Request,
): Promise<ByoScope> {
	const project = await resolveCliProject(orgId, projectRef);
	if (!project) {
		return {
			error: NextResponse.json({ error: "Project not found" }, { status: 404 }),
		};
	}
	const target = await resolveCliWriteEnvironment(
		project.id,
		new URL(req.url).searchParams.get("env"),
	);
	if (!target.ok) return { error: cliEnvironmentError(target) };
	return { projectId: project.id, environmentId: target.id };
}

/**
 * Maps a BYO write failure to a status the caller can act on.
 *
 * The distinctions matter because these actions throw for genuinely different reasons and a single
 * 500 would hide all of them:
 *
 *  - **501** when the instance has the feature switched off. This is not the caller's mistake and
 *    not a server fault — the capability is absent, and the message names the env var, so an operator
 *    reading a CI log knows what to change. A 403 would suggest a permissions problem they cannot
 *    find.
 *  - **409** when IaC attachment is refused because the environment already holds template state.
 *    That is a conflict with reality, not a bad request; the caller must destroy or choose another
 *    environment, and no retry of the same call will ever succeed.
 *  - **400** for a malformed URL, a git chart with no path, or invalid YAML — the caller's input.
 *  - **403** for an authorization refusal.
 *  - **500** for anything left, which is ours.
 */
export function byoWriteError(err: unknown): NextResponse {
	const message = err instanceof Error ? err.message : "Internal Server Error";

	if (/not enabled on this instance/i.test(message)) {
		return NextResponse.json({ error: message }, { status: 501 });
	}
	if (/template state|already (has|holds)|cannot be attached while/i.test(message)) {
		return NextResponse.json({ error: message }, { status: 409 });
	}
	if (
		/valid YAML|valid chart repository URL|chart path|must be|invalid|required/i.test(
			message,
		)
	) {
		return NextResponse.json({ error: message }, { status: 400 });
	}
	if (/forbidden|not authorized|permission/i.test(message)) {
		return NextResponse.json({ error: message }, { status: 403 });
	}
	return NextResponse.json({ error: message }, { status: 500 });
}
