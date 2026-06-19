// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { querySpecFull } from "@/lib/queries/spec-full";
import { NextResponse } from "next/server";

/** Returns the full spec_full config for one of the CLI user's specs by project name. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ name: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "spec" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	const { name: projectName } = await params;
	if (!projectName) {
		return NextResponse.json({ error: "Project name is required" }, { status: 400 });
	}

	// querySpecFull still scopes by user_id (community-correct; threaded to org_id in 4.5).
	const [configuration] = await querySpecFull(getServiceDb(), {
		user_id: actor.userId,
		project_name: projectName,
	});

	if (!configuration) {
		return NextResponse.json({ error: "Configuration not found" }, { status: 404 });
	}

	return NextResponse.json({ configuration });
}
