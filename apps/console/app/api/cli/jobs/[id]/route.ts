// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

/** Fetches a single job by ID, verifying CLI token ownership. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) return authError;

	const userId = payload?.sub;
	if (!userId) {
		return NextResponse.json(
			{ error: "Invalid token payload" },
			{ status: 401 },
		);
	}

	const { id: jobId } = await params;

	try {
		const supabase = await createServiceRoleClient();

		const { data: job, error } = await supabase
			.from("provision_jobs")
			.select("*")
			.eq("id", jobId)
			.eq("user_id", userId)
			.single();

		if (error || !job) {
			return NextResponse.json(
				{ error: "Job not found" },
				{ status: 404 },
			);
		}

		return NextResponse.json(job);
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
