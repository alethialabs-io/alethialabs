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
	{ params }: { params: Promise<{ name: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	const { name: projectName } = await params;
	if (!projectName) {
		return NextResponse.json({ error: "Project name is required" }, { status: 400 });
	}

	// Scoped by the ACTIVE ORG (#4298). `actor.userId` is the minting profile for a service
	// token, so a user_id scope handed back a project from an org the pin excludes.
	const configuration = await getCliConfig(getServiceDb(), {
		orgId: actor.orgId,
		projectName,
		envId: new URL(req.url).searchParams.get("env") ?? undefined,
	});

	if (!configuration) {
		return NextResponse.json({ error: "Configuration not found" }, { status: 404 });
	}

	return NextResponse.json({ configuration });
}
