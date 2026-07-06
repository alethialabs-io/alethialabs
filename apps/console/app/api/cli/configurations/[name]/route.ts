// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { queryProjectFull } from "@/lib/queries/project-full";
import { NextResponse } from "next/server";

/** Returns the full project_full config for one of the CLI user's projects by project name. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ name: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	const { name: projectName } = await params;
	if (!projectName) {
		return NextResponse.json({ error: "Project name is required" }, { status: 400 });
	}

	// queryProjectFull still scopes by user_id (community-correct; threaded to org_id in 4.5).
	const [configuration] = await queryProjectFull(getServiceDb(), {
		user_id: actor.userId,
		project_name: projectName,
	});

	if (!configuration) {
		return NextResponse.json({ error: "Configuration not found" }, { status: 404 });
	}

	return NextResponse.json({ configuration });
}
