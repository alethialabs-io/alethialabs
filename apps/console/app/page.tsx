// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { getOwner } from "@/lib/auth/owner";
import { getActiveOrgSlug } from "@/app/server/actions/resolve";

/**
 * Console root. The console ships no marketing — an authenticated visitor lands in
 * their active organization, everyone else goes to sign-in. On the hosted build the
 * marketing zone owns the anonymous `/`; this page only runs for an authenticated
 * `/` handed back by the proxy/Caddy (see apps/console/microfrontends.json).
 */
export default async function HomePage() {
	const userId = await getOwner();
	if (userId) {
		redirect(`/${await getActiveOrgSlug()}`);
	}
	redirect("/login");
}
