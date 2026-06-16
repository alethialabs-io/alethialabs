// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) return authError;

	const userId = payload.sub;
	if (!userId) {
		return NextResponse.json({ error: "Invalid token payload" }, { status: 400 });
	}

	const supabase = await createServiceRoleClient();
	const { data: configurations, error } = await supabase
		.from("vine_full")
		.select("*")
		.eq("user_id", userId);

	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}

	return NextResponse.json({ configurations });
}
