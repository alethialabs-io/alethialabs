// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

// Routes that require a session. The post-signup onboarding flow (/onboarding) is
// gated too so unauthenticated hits bounce to /login instead of erroring server-side.
const PRIVATE_ROUTES = ["/dashboard", "/cli", "/onboarding"];

// Public auth UI pages — never bounce these (avoids redirect loops on a stale cookie).
const AUTH_ROUTES = ["/login", "/signup", "/auth"];

/**
 * Optimistic route guard: checks for the Better Auth session cookie (no DB hit)
 * and redirects accordingly. Full session validation happens server-side in the
 * route/layout via auth.api.getSession — this only gates navigation.
 */
export async function proxy(request: NextRequest) {
	const path = request.nextUrl.pathname;

	// Back-compat: the sign-in page moved from /auth/signin to /login. Redirect old
	// bookmarks / external links, preserving any query (e.g. ?next, MCP authorize).
	if (path === "/auth/signin") {
		const url = request.nextUrl.clone();
		url.pathname = "/login";
		return NextResponse.redirect(url);
	}

	const isAuthRoute = AUTH_ROUTES.some((r) => path.startsWith(r));
	const isPrivateRoute = PRIVATE_ROUTES.some((r) => path.startsWith(r));

	const hasSession = Boolean(getSessionCookie(request));

	if (!hasSession && !isAuthRoute && isPrivateRoute) {
		const url = request.nextUrl.clone();
		url.pathname = "/login";
		// Preserve the original path + query (e.g. ?device_code) for post-login redirect.
		const next = `${request.nextUrl.pathname}${request.nextUrl.search}`;
		if (next !== "/") url.searchParams.set("next", next);
		return NextResponse.redirect(url);
	}

	// NOTE: we deliberately do NOT bounce `hasSession && isAuthRoute` here. This cookie
	// check is optimistic (presence only, no DB hit), so a stale/expired cookie would
	// otherwise trap the user — /login → /dashboard → the server throws Unauthorized →
	// 500, with no way back to the sign-in form. The "already logged in → dashboard"
	// redirect lives in the /login page instead, gated on a *validated* session
	// (getOwner()).

	return NextResponse.next();
}

export const config = {
	matcher: [
		// All paths except static assets, image optimizer, favicon, docs, media.
		"/((?!_next/static|_next/image|favicon.ico|docs|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
	],
};
