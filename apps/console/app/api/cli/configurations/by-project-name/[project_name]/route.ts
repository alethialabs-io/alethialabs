// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { getCliConfig } from "@/lib/queries/cli-config";
import { NextResponse } from "next/server";

/** Returns the flat config for one of the CLI user's projects by project name (?env selects a
 * specific environment; default env otherwise). Assembled from the live tables via getCliConfig. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ project_name: string }> },
) {
	try {
		const auth = await authorizeCli(req, "view", { type: "project" });
		if ("error" in auth) return auth.error;
		const { actor } = auth;

		const { project_name } = await params;

		// Still scoped by user_id (community-correct; threaded to org in 4.5).
		const configuration = await getCliConfig(getServiceDb(), {
			userId: actor.userId,
			projectName: project_name,
			envId: new URL(req.url).searchParams.get("env") ?? undefined,
		});

		if (!configuration) {
			return NextResponse.json({ error: "Configuration not found" }, { status: 404 });
		}

		return NextResponse.json({ configuration });
	} catch {
		return NextResponse.json({ error: "Failed to fetch configuration" }, { status: 500 });
	}
}
