// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { zones } from "@/lib/db/schema";
import { NextResponse } from "next/server";

export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string }> }
) {
	const { id } = await params;
	if (!id) {
		return new Response(JSON.stringify({ error: "ID is required" }), { status: 400 });
	}

	const auth = await authorizeCli(req, "destroy", { type: "zone", id });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		await getServiceDb()
			.delete(zones)
			.where(and(eq(zones.id, id), eq(zones.org_id, actor.orgId)));
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to delete";
		return new Response(JSON.stringify({ error: message }), { status: 500 });
	}

	return NextResponse.json({ success: true });
}
