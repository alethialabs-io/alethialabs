// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { headers } from "next/headers";
import { getWorkspaceContext } from "@/app/server/actions/workspace";
import { auth } from "@/lib/auth";
import type { BillingPlan } from "@/lib/db/schema/enums";

// Per-user, never cached — the header reads it on every marketing page load.
export const dynamic = "force-dynamic";

interface NavContext {
	authenticated: boolean;
	/** Effective plan of the active org (community while billing is inactive). */
	plan?: BillingPlan;
	/** Console path to the user's active org (`/{slug}`). */
	dashboardPath?: string;
	/** Console path to the active org's billing settings (the upgrade surface). */
	upgradePath?: string;
}

/**
 * Lightweight auth + plan probe for the marketing zone's nav header. Marketing
 * shares the `alethialabs.io` origin with the console in prod, so a same-origin
 * fetch carries the Better Auth session cookie here. Returns just what the header
 * needs to swap its CTAs (Login/Sign up → Upgrade/Dashboard). Degrades to
 * `{ authenticated: false }` on any error so the header falls back to signed-out.
 */
export async function GET(): Promise<Response> {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return Response.json({ authenticated: false } satisfies NavContext);
		}

		const { activeOrgId, organizations } = await getWorkspaceContext();
		const active =
			organizations.find((o) => o.id === activeOrgId) ?? organizations[0];
		if (!active) {
			return Response.json({ authenticated: false } satisfies NavContext);
		}

		return Response.json({
			authenticated: true,
			plan: active.plan,
			dashboardPath: `/${active.slug}`,
			upgradePath: `/${active.slug}/~/settings/billing`,
		} satisfies NavContext);
	} catch {
		return Response.json({ authenticated: false } satisfies NavContext);
	}
}
