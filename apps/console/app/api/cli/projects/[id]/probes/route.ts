// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/projects/:id/probes — each environment's latest cluster-alive probe (the "is it
// still up?" day-2 signal). Gated on project `view`; org-scoped via getLatestProbesByEnv's own
// explicit org filter plus the resolveCliProject org lookup. Reuses the same read the console
// reconcile badges use.
//
// THE COLLECTION PAGED HERE IS `project_environments`, NOT `environment_probes`. One row out per
// environment is the response's contract, so the cursor walks environments — over the same
// `(created_at DESC, id DESC)` keyset every other converted CLI list uses — and each page's
// environments are then handed to getLatestProbesByEnv, which reads at most one probe row per
// environment through the LATERAL. Both halves are bounded by the page, so an append-only probe
// history that grows forever no longer changes what this route costs.

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authorizeCli } from "@/lib/authz/guard";
import {
	type CursorScope,
	MAX_PAGE_SIZE,
	cursorKey,
	paginate,
	parsePageOpts,
} from "@/lib/cli/paging";
import { resolveCliProject } from "@/lib/cli/resolve-project";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { projectEnvironments } from "@/lib/db/schema";
import { getLatestProbesByEnv } from "@/lib/probes/persistence";
import { cliProbesResponse } from "@/lib/validations/cli-contract";

/** Cursor binding for this collection — a probes cursor is refused by any other list. */
const PROBES_LIST = "project-probes";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;
	const { searchParams } = new URL(req.url);
	const cursorScope: CursorScope = { orgId: actor.orgId, list: PROBES_LIST };
	const parsed = parsePageOpts(searchParams, cursorScope);
	if (!parsed.ok) {
		return NextResponse.json({ error: parsed.error }, { status: 400 });
	}
	const asked = (key: string) => {
		const raw = searchParams.get(key);
		return raw !== null && raw !== "";
	};
	// This route used to return every environment in one body, and a CLI that has not learned to
	// walk a cursor yet must keep seeing that. A caller who names neither `limit` nor `cursor`
	// therefore gets the largest bounded page rather than the default 50 — same compatibility
	// choice as the environments list, and the same bound.
	const opts =
		!asked("limit") && !asked("cursor")
			? { ...parsed.opts, limit: MAX_PAGE_SIZE }
			: parsed.opts;

	try {
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}

		const db = getServiceDb();
		const { items, page } = await paginate({
			db,
			table: projectEnvironments,
			createdAt: projectEnvironments.created_at,
			id: projectEnvironments.id,
			scope: [eq(projectEnvironments.project_id, project.id)],
			cursor: cursorScope,
			opts,
			rows: (query) =>
				db
					.select({
						id: projectEnvironments.id,
						name: projectEnvironments.name,
						cursor_key: cursorKey(projectEnvironments.created_at),
					})
					.from(projectEnvironments)
					.where(query.where)
					.orderBy(...query.orderBy)
					.limit(query.limit),
			positionOf: (row) => ({ createdAt: row.cursor_key, id: row.id }),
		});

		// `items` is the trimmed page, so this asks for at most `limit` environments — never the
		// extra probe row paginate() fetched to decide `next_cursor`, and never the whole project.
		const probeMap = await getLatestProbesByEnv(
			project.id,
			actor.orgId,
			items.map((e) => e.id),
		);

		return cliJson(cliProbesResponse, {
			probes: items.map((e) => {
				const p = probeMap.get(e.id);
				return {
					environment_id: e.id,
					environment: e.name,
					// Absent from the map = never probed, which is `null` on the wire and not `false`.
					reachable: p ? p.reachable : null,
					message: p ? p.message : null,
					probed_at: p ? p.probedAt : null,
				};
			}),
			page,
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
