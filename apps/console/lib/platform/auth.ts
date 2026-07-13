// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/auth/internal-auth";

/**
 * Verifies a platform-internal request (Terraform, the ECS scaler) carrying
 * `Authorization: Bearer ${RELEASE_API_SECRET}`. Returns a 401 response when the
 * header is missing or wrong, or `null` when the caller is authorized.
 *
 * Constant-time (via {@link bearerMatches}) and fail-closed on an unset secret. This
 * guards /api/runners/register + /api/platform/queue, which share RELEASE_API_SECRET with
 * the release publishers — so a timing-attackable compare HERE would leak the very secret
 * those routes protect, making their hardening worthless. Same-secret routes must all be
 * constant-time or none of them are.
 */
export function verifyPlatformSecret(req: Request): NextResponse | null {
	if (!bearerMatches(req, process.env.RELEASE_API_SECRET)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	return null;
}
