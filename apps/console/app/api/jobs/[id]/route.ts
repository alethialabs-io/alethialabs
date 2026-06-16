// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyWorkerToken } from "@/lib/workers/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { workerId, error: authError } = await verifyWorkerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;

	try {
		const supabase = await createServiceRoleClient();

		const { data: job, error } = await supabase
			.from("provision_jobs")
			.select("*")
			.eq("id", jobId)
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
