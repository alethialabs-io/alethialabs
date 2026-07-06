// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { NextResponse } from "next/server";

/**
 * Verifies a platform-internal request (Terraform, the ECS scaler) carrying
 * `Authorization: Bearer ${RELEASE_API_SECRET}`. Returns a 401 response when the
 * header is missing or wrong, or `null` when the caller is authorized.
 */
export function verifyPlatformSecret(req: Request): NextResponse | null {
	const authHeader = req.headers.get("authorization");
	const expected = process.env.RELEASE_API_SECRET;

	if (!expected || authHeader !== `Bearer ${expected}`) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	return null;
}
