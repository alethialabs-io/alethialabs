// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { NextResponse, type NextRequest } from "next/server";

// Better Auth's default session cookie (no custom cookiePrefix in the console
// config). Prefixed with `__Secure-` once served over HTTPS.
const SESSION_COOKIE = "better-auth.session_token";
const SESSION_COOKIE_SECURE = "__Secure-better-auth.session_token";

/**
 * Marketing owns the bare root `/`, but an authenticated visitor should land in
 * the console (parity with the old console home, which redirected logged-in users
 * to their active org). When a Better Auth session cookie is present on `/`, hand
 * off to the console-owned `/dashboard`, which resolves the active org and
 * redirects to `/{org}`. Anonymous visitors see the marketing landing.
 */
export function proxy(req: NextRequest) {
	const hasSession =
		req.cookies.has(SESSION_COOKIE) || req.cookies.has(SESSION_COOKIE_SECURE);
	if (hasSession) {
		return NextResponse.redirect(new URL("/dashboard", req.url));
	}
	return NextResponse.next();
}

export const config = { matcher: ["/"] };
