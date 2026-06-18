// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import { querySpecFull } from "@/lib/queries/spec-full";
import { NextResponse } from "next/server";

/** Returns the full spec_full config for one of the CLI user's specs by project name. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ project_name: string }> },
) {
	try {
		const { payload, error: authError } = await verifyCliToken(req);
		if (authError) return authError;

		const userId = payload.sub;
		if (!userId) {
			return NextResponse.json({ error: "Invalid token payload" }, { status: 400 });
		}

		const { project_name } = await params;

		const [data] = await querySpecFull(getServiceDb(), {
			user_id: userId,
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
