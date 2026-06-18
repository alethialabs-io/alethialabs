// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as conn from "@/lib/cloud-providers/connections";
import { errorResponse, resolveCliProvider } from "@/lib/cli/providers";
import { NextResponse } from "next/server";

type DisconnectBody = { identity_id?: string };

/** Resets a provider identity to its pending state and orphans its vines. */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ provider: string }> },
) {
	const { userId, provider, errorResponse: authError } =
		await resolveCliProvider(req, params);
	if (authError) return authError;

	let body: DisconnectBody;
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	if (!body.identity_id) {
		return NextResponse.json(
			{ error: "Missing identity_id" },
			{ status: 400 },
		);
	}

	try {
		const result = await conn.disconnectIdentity(
			userId,
			body.identity_id,
			provider,
		);
		return NextResponse.json(result);
	} catch (err) {
		return errorResponse(err, 400);
	}
}
