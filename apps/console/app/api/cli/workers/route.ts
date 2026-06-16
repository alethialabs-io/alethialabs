// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

/** Lists workers owned by the CLI user (plus cloud-hosted workers visible to all). */
export async function GET(req: Request) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) return authError;

	const userId = payload?.sub;
	if (!userId) {
		return NextResponse.json(
			{ error: "Invalid token payload" },
			{ status: 401 },
		);
	}

	try {
		const supabase = await createServiceRoleClient();

		const { data: workers, error } = await supabase
			.from("workers")
			.select(
				"id, name, mode, status, last_heartbeat, version, is_default, created_at",
			)
			.or(`user_id.eq.${userId},mode.eq.cloud-hosted`)
			.order("is_default", { ascending: false })
			.order("created_at", { ascending: false });

		if (error) {
			return NextResponse.json(
				{ error: error.message },
				{ status: 500 },
			);
		}

		return NextResponse.json({ workers });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
