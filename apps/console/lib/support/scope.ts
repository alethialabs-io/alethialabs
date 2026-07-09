// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Tiered scoping for support cases. Cases are ORG-OWNED: the requester sees their own, and
// owners/admins (holders of the PDP `support_case:manage_support` capability) see EVERY case
// in the org. The decision lives entirely in RLS — this sets the active-org scope plus a
// third GUC `app.support_all` that the support_cases policy reads (see programmables.sql).
// Shared by the customer server actions and the SSE stream route so visibility is consistent.

import { sql } from "drizzle-orm";
import { getPdp } from "@/lib/authz";
import type { Actor } from "@/lib/authz/types";
import { type Tx, withScope } from "@/lib/db";
import { supportCases } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * Runs `fn` in the caller's org scope with the tiered support-visibility flag set:
 * `app.support_all` is 'true' only when the caller holds `support_case:manage_support`
 * (owner/admin), so the RLS policy reveals the whole org's cases; otherwise it falls back to
 * own-only (fail closed). Personal/community orgs collapse to today's behavior (orgId === userId).
 */
export async function withSupportScope<T>(
	actor: Actor,
	fn: (tx: Tx) => Promise<T>,
): Promise<T> {
	const seeAll = (
		await getPdp().can(actor, "manage_support", { type: "support_case" })
	).allowed;
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
		await tx.execute(
			sql`select set_config('app.support_all', ${seeAll ? "true" : "false"}, true)`,
		);
		return fn(tx);
	});
}

/**
 * Whether `actor` may see the given case under the tiered RLS — probes it on the
 * RLS-enforced connection (so the visibility decision is the policy's, not an ad-hoc
 * user_id compare). Used by the SSE route, which then streams the public thread over the
 * service role once visibility is confirmed.
 */
export async function isSupportCaseVisible(
	actor: Actor,
	caseId: string,
): Promise<boolean> {
	return withSupportScope(actor, async (tx) => {
		const [row] = await tx
			.select({ id: supportCases.id })
			.from(supportCases)
			.where(eq(supportCases.id, caseId))
			.limit(1);
		return Boolean(row);
	});
}
