// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createServerClient } from "@supabase/ssr";
import { env } from "next-runtime-env";
import { type NextRequest, NextResponse } from "next/server";

const PRIVATE_ROUTES = ["/dashboard", "/cli"];

export async function updateSession(request: NextRequest) {
	let supabaseResponse = NextResponse.next({
		request,
	});

	const supabase = createServerClient(
		env("NEXT_PUBLIC_SUPABASE_URL")!,
		env("NEXT_PUBLIC_SUPABASE_ANON_KEY")!,
		{
			cookies: {
				getAll() {
					return request.cookies.getAll();
				},
				setAll(cookiesToSet) {
					cookiesToSet.forEach(({ name, value }) =>
						request.cookies.set(name, value),
					);
					supabaseResponse = NextResponse.next({
						request,
					});
					cookiesToSet.forEach(({ name, value, options }) =>
						supabaseResponse.cookies.set(name, value, options),
					);
				},
			},
		},
	);

	// Do not run code between createServerClient and
	// supabase.auth.getUser(). A simple mistake could make it very hard to debug
	// issues with users being randomly logged out.

	// IMPORTANT: DO NOT REMOVE auth.getUser()

	const {
		data: { user },
	} = await supabase.auth.getUser();

	// If an OAuth code landed on a non-callback path, redirect to the callback route
	// so the provider token gets captured and saved to provider_tokens
	const code = request.nextUrl.searchParams.get("code");
	const currentPath = request.nextUrl.pathname;
	if (code && currentPath !== "/api/auth/callback") {
		const appUrl = env("NEXT_PUBLIC_APP_URL") || request.nextUrl.origin;
		const url = new URL("/api/auth/callback", appUrl);
		url.searchParams.set("code", code);
		if (!request.nextUrl.searchParams.has("next")) {
			url.searchParams.set("next", "/dashboard/integrations");
		} else {
			url.searchParams.set("next", request.nextUrl.searchParams.get("next")!);
		}
		const redirectResponse = NextResponse.redirect(url);
		supabaseResponse.cookies.getAll().forEach((cookie) => {
			redirectResponse.cookies.set(cookie.name, cookie.value);
		});
		return redirectResponse;
	}

	const isAuthRoute = currentPath.startsWith("/auth");

	const isPrivateRoute = PRIVATE_ROUTES.some((route) =>
		currentPath.startsWith(route),
	);

	if (!user && !isAuthRoute && isPrivateRoute) {
		// no user, potentially respond by redirecting the user to the login page
		const url = request.nextUrl.clone();
		url.pathname = "/auth/signin";

		// Preserve the exact path (including query params like ?device_code) for post-login redirect
		const nextUrl = `${request.nextUrl.pathname}${request.nextUrl.search}`;
		if (nextUrl !== "/") {
			url.searchParams.set("next", nextUrl);
		}

		return NextResponse.redirect(url);
	}

	// now we need to disable viewing of /auth routes if the user is logged in
	if (user && isAuthRoute) {
		// user is logged in, redirect to the dashboard
		const url = request.nextUrl.clone();
		url.pathname = "/dashboard";
		return NextResponse.redirect(url);
	}

	// IMPORTANT: You *must* return the supabaseResponse object as it is.
	// If you're creating a new response object with NextResponse.next() make sure to:
	// 1. Pass the request in it, like so:
	//    const myNewResponse = NextResponse.next({ request })
	// 2. Copy over the cookies, like so:
	//    myNewResponse.cookies.setAll(supabaseResponse.cookies.getAll())
	// 3. Change the myNewResponse object to fit your needs, but avoid changing
	//    the cookies!
	// 4. Finally:
	//    return myNewResponse
	// If this is not done, you may be causing the browser and server to go out
	// of sync and terminate the user's session prematurely!

	return supabaseResponse;
}
