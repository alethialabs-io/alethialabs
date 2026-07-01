// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { getActiveOrgSlug } from "@/app/server/actions/resolve";
import { getOwner } from "@/lib/auth/owner";
import { isOnboardingComplete } from "@/lib/auth/onboarding";

/**
 * Legacy `/dashboard/*` catch-all → canonicalizes to the org-scoped tree. After C2c
 * the global pages live at `/{org}/~/…`, so any old `/dashboard/X` link, the
 * post-login redirect, and bookmarks 307 here to `/{org}/~/X` (root → `/{org}`).
 * The specific `dashboard/...` UUID redirectors win over this catch-all.
 */
export default async function DashboardLegacyRedirect({
	params,
	searchParams,
}: {
	params: Promise<{ rest?: string[] }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { rest } = await params;
	const sp = await searchParams;
	// The middleware guard is optimistic (cookie presence only), so a stale/expired
	// cookie can reach here without a valid session — getActiveOrgSlug() would then throw
	// Unauthorized and 500. Send those to sign-in instead.
	const userId = await getOwner();
	if (!userId) redirect("/login");
	// Brand-new signups land here post-auth; route them through the /onboarding
	// flow until they finish it (pre-existing users are backfilled → skip).
	if (!(await isOnboardingComplete(userId))) redirect("/onboarding");
	const org = await getActiveOrgSlug();
	const sub = (rest ?? []).join("/");
	// Preserve any query string (e.g. `?scan=<jobId>` for the scan→design bridge) so
	// legacy `/dashboard/X?q=…` links don't lose their params on canonicalization.
	const qs = new URLSearchParams(
		Object.entries(sp).flatMap(([k, v]) =>
			v == null ? [] : Array.isArray(v) ? v.map((x) => [k, x] as [string, string]) : [[k, v]],
		),
	).toString();
	const suffix = qs ? `?${qs}` : "";
	// Account settings is now a dialog (no page); send the old `/dashboard/profile`
	// bookmark to the org root rather than a dead `/{org}/~/profile`.
	if (sub === "profile") redirect(`/${org}`);
	redirect(sub ? `/${org}/~/${sub}${suffix}` : `/${org}${suffix}`);
}
