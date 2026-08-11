// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/configurations/by-project-name/:project_name/export
//
// This route did not exist. `alethia config export` has always called it, so the command 404'd for its
// whole life — and it asked for `format=legacy-yaml`, a format with no producer anywhere in the repo
// (grep found it only in the CLI, its own tests, and a docs page describing the 404). The command's
// unit test passed because it renders a struct a fakeClient hands it; nothing ever exercised the call.
//
// It emits the DESIGN DOCUMENT — `getProjectAsFormData`'s `formData`, the same nested shape the console
// design form holds and the same one `projectFormSchema` validates. That choice is what makes the pair
// useful: this document is exactly what `POST .../design` accepts, so
//
//     alethia config export -p shop > shop.json   # edit it
//     alethia project design apply -f shop.json
//
// round-trips through ONE shape with one producer and one consumer. Emitting the flat `getCliConfig`
// shape instead (what `project get` reads) would have been easier and would have given a document you
// cannot apply.

import { NextResponse } from "next/server";
import { getProjectAsFormData } from "@/app/server/actions/projects";
import { runWithActor } from "@/lib/authz/actor-context";
import { authorizeCli } from "@/lib/authz/guard";
import {
	resolveCliEnvironment,
	resolveCliProject,
} from "@/lib/cli/resolve-project";

/** Formats this route can emit. `legacy-yaml` is refused BY NAME: it is what the CLI defaulted to, and
 *  a caller who pinned it deserves to be told it never existed rather than handed JSON labelled YAML. */
const FORMATS = new Set(["json"]);

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ project_name: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	const url = new URL(req.url);
	const format = url.searchParams.get("format") ?? "json";
	if (!FORMATS.has(format)) {
		return NextResponse.json(
			{
				error: `Unsupported export format "${format}". This endpoint emits json. (The CLI once defaulted to "legacy-yaml", a format nothing has ever produced — upgrade the CLI, or pass format=json.)`,
			},
			{ status: 400 },
		);
	}

	try {
		const { project_name } = await params;
		const project = await resolveCliProject(actor.orgId, project_name);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}

		const envParam = url.searchParams.get("env");
		let environmentId: string | null = null;
		if (envParam) {
			const env = await resolveCliEnvironment(project.id, envParam);
			if (!env) {
				return NextResponse.json(
					{ error: `Environment "${envParam}" not found` },
					{ status: 404 },
				);
			}
			environmentId = env.id;
		}

		// runWithActor so getProjectAsFormData's own authorize()/withActorScope run under the CLI actor
		// rather than looking for a session that is not there.
		const { formData } = await runWithActor(actor, () =>
			getProjectAsFormData(project.id, environmentId),
		);

		// `content` is a STRING, matching the Go ConfigurationExport the CLI decodes: the command writes
		// a file, so the server owns the serialization and the CLI stays a courier.
		return NextResponse.json({
			content: `${JSON.stringify(formData, null, 2)}\n`,
			filename: `${project.project_name}.json`,
			format: "json",
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Failed to export";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
