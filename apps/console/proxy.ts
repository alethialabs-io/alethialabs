// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

// Routes that require a session. Auth UI pages live under /auth.
const PRIVATE_ROUTES = ["/dashboard", "/cli"];

/**
 * Optimistic route guard: checks for the Better Auth session cookie (no DB hit)
 * and redirects accordingly. Full session validation happens server-side in the
 * route/layout via auth.api.getSession — this only gates navigation.
 */
export async function proxy(request: NextRequest) {
	const path = request.nextUrl.pathname;
	const isAuthRoute = path.startsWith("/auth");
	const isPrivateRoute = PRIVATE_ROUTES.some((r) => path.startsWith(r));

	const hasSession = Boolean(getSessionCookie(request));

	if (!hasSession && !isAuthRoute && isPrivateRoute) {
		const url = request.nextUrl.clone();
		url.pathname = "/auth/signin";
		// Preserve the original path + query (e.g. ?device_code) for post-login redirect.
		const next = `${request.nextUrl.pathname}${request.nextUrl.search}`;
		if (next !== "/") url.searchParams.set("next", next);
		return NextResponse.redirect(url);
	}

	// NOTE: we deliberately do NOT bounce `hasSession && isAuthRoute` here. This cookie
	// check is optimistic (presence only, no DB hit), so a stale/expired cookie would
	// otherwise trap the user — /auth/signin → /dashboard → the server throws
	// Unauthorized → 500, with no way back to the sign-in form. The "already logged in →
	// dashboard" redirect lives in the sign-in page instead, gated on a *validated*
	// session (getOwner()).

	return NextResponse.next();
}

export const config = {
	matcher: [
		// All paths except static assets, image optimizer, favicon, docs, media.
		"/((?!_next/static|_next/image|favicon.ico|docs|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
	],
};
