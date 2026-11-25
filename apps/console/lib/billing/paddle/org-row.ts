// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Paddle columns of an org's billing row, for the adapter's management calls (the portal needs
// the customer and its subscriptions). Its own module, reading the table directly, so the adapter
// does not import lib/billing/queries.ts — which would reach lib/billing/config.ts and close a cycle
// through provider/select.ts. Service role: the caller has already authorized the org.

import { eq } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { organizationBilling } from "@/lib/db/schema";

/** An org's Paddle linkage. */
export interface PaddleOrgRow {
	paddleCustomerId: string | null;
	paddleSubscriptionId: string | null;
	aiPaddleSubscriptionId: string | null;
}

/** The org's Paddle linkage, or null when it has no billing row. */
export async function readPaddleOrgRow(organizationId: string): Promise<PaddleOrgRow | null> {
	const [row] = await getServiceDb()
		.select({
			paddleCustomerId: organizationBilling.paddleCustomerId,
			paddleSubscriptionId: organizationBilling.paddleSubscriptionId,
			aiPaddleSubscriptionId: organizationBilling.aiPaddleSubscriptionId,
		})
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, organizationId))
		.limit(1);
	return row ?? null;
}
