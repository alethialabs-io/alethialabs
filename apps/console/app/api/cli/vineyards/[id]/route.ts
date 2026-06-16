// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string }> }
) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) {
		return authError;
	}

	const userId = payload.sub;
	if (!userId) {
		return new Response(
			JSON.stringify({ error: "Invalid token payload" }),
			{ status: 400 }
		);
	}

	const { id } = await params;
	if (!id) {
		return new Response(JSON.stringify({ error: "ID is required" }), { status: 400 });
	}

	const supabase = await createServiceRoleClient();
	const { error } = await supabase
		.from("vineyards")
		.delete()
		.eq("id", id)
		.eq("user_id", userId);

	if (error) {
		return new Response(JSON.stringify({ error: error.message }), { status: 500 });
	}

	return NextResponse.json({ success: true });
}
