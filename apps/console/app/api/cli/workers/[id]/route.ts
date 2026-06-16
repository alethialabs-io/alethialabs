// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

/** Deletes a worker record owned by the CLI user (no cloud teardown). */
export async function DELETE(
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

	const { id: workerId } = await params;

	try {
		const supabase = await createServiceRoleClient();

		const { data: worker, error: fetchError } = await supabase
			.from("workers")
			.select("id, user_id")
			.eq("id", workerId)
			.single();

		if (fetchError || !worker) {
			return NextResponse.json(
				{ error: "Worker not found" },
				{ status: 404 },
			);
		}

		if (worker.user_id !== userId) {
			return NextResponse.json(
				{ error: "Unauthorized: you do not own this worker" },
				{ status: 403 },
			);
		}

		const { error: deleteError } = await supabase
			.from("workers")
			.delete()
			.eq("id", workerId);

		if (deleteError) {
			return NextResponse.json(
				{ error: "Failed to delete worker: " + deleteError.message },
				{ status: 500 },
			);
		}

		return NextResponse.json({ success: true });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
