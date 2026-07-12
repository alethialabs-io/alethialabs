// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { NextResponse } from "next/server";

// Better Auth's default session cookie (no custom cookiePrefix in the console
// config), `__Secure-`-prefixed once served over HTTPS. These are exactly the
// cookies Caddy's `@authed_root` rule keys on (deploy/prod/Caddyfile.tunnel), so
// dropping them lets a stale-cookie `/` fall through to the marketing landing.
const SESSION_COOKIES = [
	"better-auth.session_token",
	"__Secure-better-auth.session_token",
];

// Always evaluated at request time — it only sets cookies and redirects.
export const dynamic = "force-dynamic";

/**
 * Clears a stale/invalid Better Auth session cookie, then bounces back to `/`.
 *
 * The console root (app/page.tsx) sends a null-owner visitor here. On the hosted
 * build Caddy routes `/` to the console whenever a session cookie is *present*
 * (its `@authed_root` match tests cookie presence, not validity), so an expired
 * cookie would otherwise trap the visitor on /login and they'd never see the
 * marketing landing. After the cookie is dropped, the next `/` request no longer
 * matches `@authed_root` and falls through to the marketing zone. Lands on
 * `/?from=reset` so app/page.tsx can break the loop if the cookie somehow survives.
 */
export function GET(): NextResponse {
	// Relative `Location` (not NextResponse.redirect, which needs an absolute URL
	// built from the request host — internal behind the Cloudflare Tunnel). The
	// browser resolves it against the current origin.
	const res = new NextResponse(null, {
		status: 307,
		headers: { Location: "/?from=reset" },
	});
	for (const name of SESSION_COOKIES) {
		res.cookies.set(name, "", {
			path: "/",
			maxAge: 0,
			sameSite: "lax",
			secure: name.startsWith("__Secure-"),
		});
	}
	return res;
}
