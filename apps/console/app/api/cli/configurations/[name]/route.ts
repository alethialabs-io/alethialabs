// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import { querySpecFull } from "@/lib/queries/spec-full";
import { NextResponse } from "next/server";

/** Returns the full spec_full config for one of the CLI user's specs by project name. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ name: string }> },
) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) return authError;

	const userId = payload.sub;
	if (!userId) {
		return NextResponse.json({ error: "Invalid token payload" }, { status: 400 });
	}

	const { name: projectName } = await params;
	if (!projectName) {
		return NextResponse.json({ error: "Project name is required" }, { status: 400 });
	}

	const [configuration] = await querySpecFull(getServiceDb(), {
		user_id: userId,
		project_name: projectName,
	});

	if (!configuration) {
		return NextResponse.json({ error: "Configuration not found" }, { status: 404 });
	}

	return NextResponse.json({ configuration });
}
