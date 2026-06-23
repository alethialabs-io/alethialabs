// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { getActiveOrgSlug } from "@/app/server/actions/resolve";

/**
 * Legacy `/dashboard/*` catch-all → canonicalizes to the org-scoped tree. After C2c
 * the global pages live at `/{org}/~/…`, so any old `/dashboard/X` link, the
 * post-login redirect, and bookmarks 307 here to `/{org}/~/X` (root → `/{org}`).
 * The specific `dashboard/zones/[id]` UUID redirectors win over this catch-all.
 */
export default async function DashboardLegacyRedirect({
	params,
}: {
	params: Promise<{ rest?: string[] }>;
}) {
	const { rest } = await params;
	const org = await getActiveOrgSlug();
	const sub = (rest ?? []).join("/");
	redirect(sub ? `/${org}/~/${sub}` : `/${org}`);
}
