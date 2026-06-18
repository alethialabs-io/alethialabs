// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as conn from "@/lib/cloud-providers/connections";
import { errorResponse, resolveCliProvider } from "@/lib/cli/providers";
import { NextResponse } from "next/server";

/** Returns the verified connection status for a provider. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ provider: string }> },
) {
	const { userId, provider, errorResponse: authError } =
		await resolveCliProvider(req, params);
	if (authError) return authError;

	try {
		const status = await conn.getStatus(userId, provider);
		return NextResponse.json(status);
	} catch (err) {
		return errorResponse(err, 500);
	}
}
