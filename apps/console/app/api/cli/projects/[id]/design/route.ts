// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/cli/projects/:id/design — apply a whole environment DESIGN DOCUMENT at once.
//
// The declarative counterpart to `project component add`. The imperative commands are what a demo
// narrates, one visible step at a time; this is what a repository commits and CI replays. Both write
// the same tables, and neither reimplements the other: this route is a thin edge over the engine the
// console already uses.
//
//   ?dry_run   → diffConfig only. Nothing is written, and the response is the per-component CREATE /
//                UPDATE / DELETE rows, so a pipeline can show a plan before it changes anything.
//   ?stage     → stageChanges. The change lands in the staged-changes tray for the environment's
//                normal review-and-apply path instead of going live.
//   (neither)  → updateProjectDesign. Applied directly to the environment's live component tables.
//
// The body is validated by `projectFormSchema` — the CONSOLE FORM's own validator, including its
// cross-field refinements (the node min/max/desired ordering, the VPC rule). So a document the form
// would reject cannot be smuggled in through the CLI, and there is one definition of a valid design.

import { NextResponse } from "next/server";
import { stageChanges } from "@/app/server/actions/staged-changes";
// The differ comes from lib/config-diff, NOT from the actions module: `"use server"` requires every
// export there to be async, and diffConfig is a pure synchronous function.
import { type DiffRow, diffConfig } from "@/lib/config-diff";
import { updateProjectDesign } from "@/app/server/actions/projects";
import { getProjectAsFormData } from "@/app/server/actions/projects";
import { runWithActor } from "@/lib/authz/actor-context";
import { authorizeCli } from "@/lib/authz/guard";
import {
	resolveCliProject,
	resolveCliWriteEnvironment,
} from "@/lib/cli/resolve-project";
import { cliEnvironmentError, cliJson } from "@/lib/cli/respond";
import { projectFormSchema } from "@/lib/validations/project-form.schema";
import { cliDesignApplyResponse } from "@/lib/validations/cli-contract";

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "edit", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	const raw = await req.json().catch(() => null);
	const parsed = projectFormSchema.safeParse(raw);
	if (!parsed.success) {
		// The FIRST issue with its path, not the whole ZodError: a design document has hundreds of
		// fields, and a caller needs to know which one is wrong more than they need every one at once.
		const first = parsed.error.issues[0];
		const where = first?.path.join(".") || "document";
		return NextResponse.json(
			{ error: `Invalid design document at ${where}: ${first?.message ?? "invalid"}` },
			{ status: 400 },
		);
	}

	const url = new URL(req.url);
	const dryRun = url.searchParams.has("dry_run");
	const stage = url.searchParams.has("stage");

	try {
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}
		const target = await resolveCliWriteEnvironment(
			project.id,
			url.searchParams.get("env"),
		);
		if (!target.ok) return cliEnvironmentError(target);

		if (dryRun) {
			// Diffed against the environment's CURRENT design, read through the same serializer the
			// export emits — so a dry run compares like with like.
			const changes = await runWithActor(actor, async () => {
				const { formData } = await getProjectAsFormData(project.id, target.id);
				return diffConfig(formData, parsed.data);
			});
			return cliJson(cliDesignApplyResponse, {
				ok: true,
				mode: "dry-run",
				// DiffRow's own field names (component_type / component_id / op) are the staged-changes
				// table's; the wire uses kind / name / action to match how every other CLI response
				// talks about a component.
				changes: changes.map((c: DiffRow) => ({
					kind: c.component_type,
					name: c.component_id,
					action: c.op,
				})),
			});
		}

		if (stage) {
			await runWithActor(actor, () =>
				stageChanges(project.id, target.id, parsed.data),
			);
			return cliJson(cliDesignApplyResponse, {
				ok: true,
				mode: "staged",
				changes: [],
			});
		}

		await runWithActor(actor, () =>
			updateProjectDesign(project.id, target.id, parsed.data),
		);
		return cliJson(cliDesignApplyResponse, {
			ok: true,
			mode: "applied",
			changes: [],
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		if (/forbidden|not authorized|permission/i.test(message)) {
			return NextResponse.json({ error: message }, { status: 403 });
		}
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
