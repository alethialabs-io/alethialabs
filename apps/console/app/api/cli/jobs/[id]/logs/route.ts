// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

/** Fetches job logs for a CLI user, with optional pagination via ?after=<id>. */
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
	const { searchParams } = new URL(req.url);
	const after = searchParams.get("after");

	try {
		const supabase = await createServiceRoleClient();

		const { data: job, error: jobError } = await supabase
			.from("provision_jobs")
			.select("id")
			.eq("id", jobId)
			.eq("user_id", userId)
			.single();

		if (jobError || !job) {
			return NextResponse.json(
				{ error: "Job not found or unauthorized" },
				{ status: 404 },
			);
		}

		let query = supabase
			.from("job_logs")
			.select("*")
			.eq("job_id", jobId)
			.order("id", { ascending: true });

		if (after) {
			query = query.gt("id", parseInt(after, 10));
		}

		const { data: logs, error } = await query;

		if (error) {
			return NextResponse.json(
				{ error: error.message },
				{ status: 500 },
			);
		}

		return NextResponse.json({ logs });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
