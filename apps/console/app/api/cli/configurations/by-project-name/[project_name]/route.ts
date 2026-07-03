// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { queryProjectFull } from "@/lib/queries/project-full";
import { NextResponse } from "next/server";

/** Returns the full project_full config for one of the CLI user's projects by project name. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ project_name: string }> },
) {
	try {
		const auth = await authorizeCli(req, "view", { type: "project" });
		if ("error" in auth) return auth.error;
		const { actor } = auth;

		const { project_name } = await params;

		// queryProjectFull still scopes by user_id (community-correct; threaded to org in 4.5).
		const [data] = await queryProjectFull(getServiceDb(), {
			user_id: actor.userId,
			project_name,
		});

		if (!data) {
			return NextResponse.json({ error: "Configuration not found" }, { status: 404 });
		}

		return NextResponse.json({ configuration: data });
	} catch {
		return NextResponse.json({ error: "Failed to fetch configuration" }, { status: 500 });
	}
}
