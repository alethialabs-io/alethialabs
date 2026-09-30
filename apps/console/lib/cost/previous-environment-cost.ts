// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cost baseline a promotion's cost gate measures its delta against.
//
// This lives in lib/, NOT in app/server/actions/cost.ts, for two reasons that are the same reason:
//
// 1. It is service-role and does not authorize. Inside a `"use server"` file every export is a
//    POST-addressable Server Action, so it was readable by anyone holding an environment id.
// 2. Its only caller is the promotion lifecycle (lib/promotions/lifecycle.ts), which runs from the
//    job-status route and from the B6.1 e2e shim — outside any session. Importing it from the
//    actions file pulled lib/authz/guard → lib/auth into that graph, and lib/auth validates
//    BETTER_AUTH_* at MODULE LOAD, so a script path that needs no session could not even start.
//
// Do not add `"use server"` here, and do not import lib/auth or lib/authz/guard from this file.

import { and, desc, eq, lt } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { environmentCost } from "@/lib/db/schema";

/**
 * The environment's cost BEFORE the given plan — the baseline a delta is measured against.
 *
 * This is the number the promotion gate passed as `null` since the gate was written ("Cost baseline
 * isn't persisted per-env yet"), which is why the cost promotion gate never evaluated. Service-role:
 * called from the promotion pipeline, which has already authorized.
 */
export async function getPreviousEnvironmentCost(
	environmentId: string,
	beforePlanJobId: string,
): Promise<number | null> {
	const db = getServiceDb();

	// This plan's own row — the point in time we look BEFORE.
	const [current] = await db
		.select({ captured_at: environmentCost.captured_at })
		.from(environmentCost)
		.where(
			and(
				eq(environmentCost.environment_id, environmentId),
				eq(environmentCost.plan_job_id, beforePlanJobId),
			),
		)
		.limit(1);
	if (!current) return null;

	// Strictly EARLIER than this plan's row — otherwise the baseline would be the plan itself and
	// every delta would be zero, which is worse than no gate at all: it would look like it worked.
	const [prior] = await db
		.select({ total_monthly: environmentCost.total_monthly })
		.from(environmentCost)
		.where(
			and(
				eq(environmentCost.environment_id, environmentId),
				lt(environmentCost.captured_at, current.captured_at),
			),
		)
		.orderBy(desc(environmentCost.captured_at))
		.limit(1);

	// No earlier priced plan = the first time we've costed this environment. There's no baseline,
	// so there's no delta — honest null, not a fabricated zero.
	return prior?.total_monthly ?? null;
}
