// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The billing documents an org has at a provider that does NOT mirror them into our `invoice`
// table — the provider-neutral half of the invoices list (L5). Stripe-era invoices are ours (the
// фактура) and come from the local mirror (lib/billing/invoices.ts), exactly as before. Paddle is the
// merchant of record, so a Paddle customer's invoices are Paddle's documents, listed live through
// the adapter's `listDocuments`. An org that moved from one provider to the other keeps both: the
// list is the mirror's rows plus these.
//
// Asked only when it can answer: Paddle configured on this instance AND the org's billing row holds
// a Paddle customer. Every other org costs one row read and no provider call. Server-only.

import { eq } from "drizzle-orm";
import { providerById } from "@/lib/billing/provider/select";
import type { BillingDocument } from "@/lib/billing/provider/types";
import { getServiceDb } from "@/lib/db";
import { organizationBilling } from "@/lib/db/schema";

/** What the lookup reads, injectable for tests. */
export interface ProviderDocumentDeps {
	paddleCustomerId: (organizationId: string) => Promise<string | null>;
	provider: typeof providerById;
}

/** The org's Paddle customer id, from its billing row. */
async function readPaddleCustomerId(organizationId: string): Promise<string | null> {
	const [row] = await getServiceDb()
		.select({ id: organizationBilling.paddleCustomerId })
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, organizationId))
		.limit(1);
	return row?.id ?? null;
}

const defaultDeps: ProviderDocumentDeps = { paddleCustomerId: readPaddleCustomerId, provider: providerById };

/**
 * The org's provider-hosted documents, newest first (empty when it has none). Throws when the
 * provider cannot be read, so the page shows an error rather than an incomplete list.
 */
export async function providerDocumentsForOrg(
	organizationId: string,
	opts: { limit?: number } = {},
	deps: ProviderDocumentDeps = defaultDeps,
): Promise<BillingDocument[]> {
	const paddle = deps.provider("paddle");
	if (!paddle?.isConfigured()) return [];
	if (!(await deps.paddleCustomerId(organizationId))) return [];
	return paddle.listDocuments(organizationId, opts);
}
