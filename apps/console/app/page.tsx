// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { getOwner } from "@/lib/auth/owner";
import { getActiveOrgSlug } from "@/app/server/actions/resolve";

interface HomePageProps {
	searchParams: Promise<{ from?: string }>;
}

/**
 * Console root. The console ships no marketing — an authenticated visitor lands in
 * their active organization. On the hosted build the marketing zone owns the
 * anonymous `/`; this page only runs for a `/` that Caddy handed to the console
 * because it carried a Better Auth session cookie (deploy/prod/Caddyfile.tunnel's
 * `@authed_root` matches cookie *presence*, not validity — see marketing-zones.json).
 * A *valid* session → the org; a *stale* cookie → clear it and fall through to the
 * marketing landing instead of trapping the visitor on /login.
 */
export default async function HomePage({ searchParams }: HomePageProps) {
	const userId = await getOwner();
	if (userId) {
		redirect(`/${await getActiveOrgSlug()}`);
	}
	// No valid session. If /api/session/reset already ran and the cookie somehow
	// survived (`?from=reset`), stop looping and show sign-in. Otherwise clear the
	// stale cookie so the next `/` request routes to the marketing zone.
	const { from } = await searchParams;
	if (from === "reset") {
		redirect("/login");
	}
	redirect("/api/session/reset");
}
