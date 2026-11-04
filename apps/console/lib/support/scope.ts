// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Tiered scoping for support cases. Cases are ORG-OWNED: the requester sees their own, and
// owners/admins (holders of the PDP `support_case:manage_support` capability) see EVERY case
// in the org. The decision lives entirely in RLS — this sets the active-org scope plus a
// third GUC `app.support_all` that the support_cases policy reads (see programmables.sql).
// Shared by the support read procedures and the customer server actions so visibility is consistent.

import { sql } from "drizzle-orm";
import { getPdp } from "@/lib/authz";
import type { Actor } from "@/lib/authz/types";
import { type Tx, withScope } from "@/lib/db";

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
