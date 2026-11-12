// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/cli/projects/:id/addons/bump — `alethia addon bump`: open, or find, the pull request that
// moves a GitOps add-on's seeded chart version (#6549). Gated on project `edit`, and it runs the same
// function the console card does (`requestGitopsBump`), as the CLI's user, with that user's own
// GitHub token. Defaults to the project's default environment; pass ?env= for another.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requestGitopsBump } from "@/app/server/actions/addons";
import type { GitopsBumpResult } from "@/lib/addons/gitops-bump/service";
import { runWithActor } from "@/lib/authz/actor-context";
import { authorizeCli } from "@/lib/authz/guard";
import { resolveCliProjectAuthorized } from "@/lib/cli/project-access";
import { resolveCliWriteEnvironment } from "@/lib/cli/resolve-project";
import { cliEnvironmentError, cliJson } from "@/lib/cli/respond";
import { cliGitopsBumpResponse } from "@/lib/validations/cli-contract";

/**
 * Maps a failure to a status. An authorization refusal is 403. Anything else is ours (500), and its
 * message is NOT forwarded: nothing that reaches here should carry a provider's text, and this
 * route's answer is printed by the CLI.
 */
function bumpError(err: unknown): NextResponse {
	const message = err instanceof Error ? err.message : "";
	if (/forbidden|not authorized|permission/i.test(message)) {
		return NextResponse.json({ error: "You do not have permission to change this project's add-ons." }, { status: 403 });
	}
	console.error("addons/bump: request failed", err instanceof Error ? err.name : typeof err);
	return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
}

/** Body of POST .../addons/bump. */
const bumpBody = z.object({
	addon_id: z.string().min(1).max(128),
	again: z.boolean().optional(),
});

/** The wire form of a bump result: every key present, the arms' fields null where they do not apply. */
function toWire(r: GitopsBumpResult): z.infer<typeof cliGitopsBumpResponse> {
	if (r.status === "refused") {
		return {
			status: "refused",
			created: false,
			version: r.version,
			file: r.file,
			field: r.field,
			number: null,
			url: null,
			reason: r.reason,
			message: r.message,
		};
	}
	return {
		status: r.status,
		created: r.created,
		version: r.version,
		file: r.file,
		field: r.field,
		number: r.number,
		url: r.url,
		reason: null,
		message: null,
	};
}

/** Opens or finds the bump pull request for one GitOps add-on. */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "edit", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	const parsed = bumpBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid request body: addon_id is required" }, { status: 400 });
	}

	try {
		const project = await resolveCliProjectAuthorized(actor, id, "edit");
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}
		const target = await resolveCliWriteEnvironment(project.id, new URL(req.url).searchParams.get("env"));
		if (!target.ok) return cliEnvironmentError(target);

		const result = await runWithActor(actor, () =>
			requestGitopsBump({
				projectId: project.id,
				environmentId: target.id,
				addonId: parsed.data.addon_id,
				again: parsed.data.again ?? false,
			}),
		);
		return cliJson(cliGitopsBumpResponse, toWire(result));
	} catch (err: unknown) {
		return bumpError(err);
	}
}
