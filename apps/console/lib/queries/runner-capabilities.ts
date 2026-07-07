// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, eq } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";

/**
 * Whether an org runs its own (`operator = 'self'`) runners. Drives the gated Runners nav
 * item: managed warm pools are platform-internal (support-admin), so Runners is only a
 * customer surface for orgs that operate their own. Service path with an explicit `org_id`
 * filter (the service role bypasses RLS, so the org scope is enforced here); `limit(1)`
 * keeps it an existence check, not a count.
 */
export async function orgHasSelfRunners(orgId: string): Promise<boolean> {
	const rows = await getServiceDb()
		.select({ id: runners.id })
		.from(runners)
		.where(and(eq(runners.org_id, orgId), eq(runners.operator, "self")))
		.limit(1);
	return rows.length > 0;
}
