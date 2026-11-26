// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Links an organization to its Paddle customer, for the staff app's "Link Paddle customer" operator
// action. A customer invoiced by hand from the Paddle dashboard has no checkout of ours behind it, so
// nothing else ever stores its Paddle customer id on the org's billing row; until it is stored, the
// billing mirror has no record that ties that customer's transactions to the org.
//
// The write lives here, not in the staff app, so organization_billing keeps one writer (the console),
// as set-plan does. It writes ONLY `paddle_customer_id` (and `updated_at`): the plan, the provider
// routing and every subscription column are left to their own writers.
//
// Three refusals, each naming its reason:
//  - the id is not a Paddle customer id (`ctm_` + 26 lowercase alphanumerics);
//  - the org already holds a DIFFERENT customer id and the caller did not name that value as the one
//    it means to replace (`replace`) — the staff app's confirm step. The write itself is conditional
//    on the value the decision read, so a concurrent change is refused rather than overwritten;
//  - Paddle is configured on this instance and answers that it has no such customer (the read-only
//    `GET /customers/{id}`). An instance without Paddle skips that check and reports `verified: false`.

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { PADDLE_CUSTOMER_ID_HINT, PADDLE_CUSTOMER_ID_PATTERN } from "@repo/platform/paddle";
import { PaddleApiError, type PaddleClient, paddleClient } from "@/lib/billing/paddle/api";
import { isPaddleConfigured } from "@/lib/billing/paddle/config";
import { getServiceDb } from "@/lib/db";
import { organization, organizationBilling } from "@/lib/db/schema";
import { ProvisionError } from "@/lib/platform/provision";

export interface LinkPaddleCustomerInput {
	orgId: string;
	/** The Paddle customer id to store. */
	customerId: string;
	/**
	 * The currently stored id the caller confirmed replacing, or null. A different stored value is
	 * replaced only when it equals this.
	 */
	replace: string | null;
}

export interface LinkPaddleCustomerResult {
	/** The id stored before this call (null when none). */
	previous: string | null;
	customerId: string;
	/** False when the org already held exactly this id, so nothing was written. */
	changed: boolean;
	/** True when Paddle confirmed the customer exists; false when Paddle is not configured here. */
	verified: boolean;
}

/** The billing-row reads and the one conditional write the link needs. */
export interface PaddleCustomerStore {
	/** Whether the organization exists. */
	orgExists(orgId: string): Promise<boolean>;
	/** The org's stored Paddle customer id, or null (no billing row, or none stored). */
	current(orgId: string): Promise<string | null>;
	/**
	 * Stores `customerId` on the org's billing row only while the stored value is still `expected`.
	 * Answers whether it wrote.
	 */
	write(orgId: string, customerId: string, expected: string | null): Promise<boolean>;
}

export interface LinkPaddleCustomerDeps {
	store: PaddleCustomerStore;
	/** The Paddle client, or null when Paddle is not configured on this instance. */
	client: () => PaddleClient | null;
}

/** The fields of Paddle's customer entity this check reads. */
const paddleCustomerSchema = z.looseObject({ id: z.string() });

/** The billing-row store over the service connection. */
export const postgresPaddleCustomerStore: PaddleCustomerStore = {
	async orgExists(orgId) {
		const [org] = await getServiceDb()
			.select({ id: organization.id })
			.from(organization)
			.where(eq(organization.id, orgId))
			.limit(1);
		return Boolean(org);
	},
	async current(orgId) {
		const [row] = await getServiceDb()
			.select({ id: organizationBilling.paddleCustomerId })
			.from(organizationBilling)
			.where(eq(organizationBilling.organizationId, orgId))
			.limit(1);
		return row?.id ?? null;
	},
	async write(orgId, customerId, expected) {
		const now = new Date();
		const rows = await getServiceDb()
			.insert(organizationBilling)
			.values({ organizationId: orgId, paddleCustomerId: customerId, updatedAt: now })
			.onConflictDoUpdate({
				target: organizationBilling.organizationId,
				set: { paddleCustomerId: customerId, updatedAt: now },
				setWhere: and(
					eq(organizationBilling.organizationId, orgId),
					expected === null
						? isNull(organizationBilling.paddleCustomerId)
						: eq(organizationBilling.paddleCustomerId, expected),
				),
			})
			.returning({ id: organizationBilling.organizationId });
		return rows.length > 0;
	},
};

const defaultDeps: LinkPaddleCustomerDeps = {
	store: postgresPaddleCustomerStore,
	client: () => (isPaddleConfigured() ? paddleClient() : null),
};

/** Asks Paddle whether `customerId` exists. Refuses when it does not, or when Paddle cannot answer. */
async function confirmWithPaddle(client: PaddleClient, customerId: string): Promise<void> {
	try {
		const customer = await client.request(
			{ method: "GET", path: `/customers/${encodeURIComponent(customerId)}` },
			paddleCustomerSchema,
		);
		if (customer.id !== customerId) {
			throw new ProvisionError(`Paddle answered a different customer for ${customerId}; nothing was stored.`);
		}
	} catch (err) {
		if (err instanceof PaddleApiError && err.kind === "http" && err.status === 404) {
			throw new ProvisionError(
				`Paddle (${client.environment}) has no customer ${customerId}. Check the id, and that it belongs to the ${client.environment} environment.`,
			);
		}
		if (err instanceof PaddleApiError) {
			throw new ProvisionError(`Could not confirm the customer with Paddle: ${err.message}. Nothing was stored; try again.`);
		}
		throw err;
	}
}

/**
 * Stores the org's Paddle customer id after checking its shape, the replace confirmation and (when
 * Paddle is configured) that Paddle knows the customer. Throws {@link ProvisionError} on a refusal.
 */
export async function linkPaddleCustomer(
	input: LinkPaddleCustomerInput,
	deps: LinkPaddleCustomerDeps = defaultDeps,
): Promise<LinkPaddleCustomerResult> {
	const customerId = input.customerId.trim();
	if (!PADDLE_CUSTOMER_ID_PATTERN.test(customerId)) throw new ProvisionError(PADDLE_CUSTOMER_ID_HINT);
	if (!(await deps.store.orgExists(input.orgId))) throw new ProvisionError("Organization not found.");

	const previous = await deps.store.current(input.orgId);
	if (previous === customerId) return { previous, customerId, changed: false, verified: false };
	if (previous !== null && previous !== input.replace) {
		throw new ProvisionError(
			`This organization is already linked to Paddle customer ${previous}. Confirm replacing it to continue.`,
		);
	}

	const client = deps.client();
	if (client) await confirmWithPaddle(client, customerId);

	if (!(await deps.store.write(input.orgId, customerId, previous))) {
		throw new ProvisionError("The organization's Paddle customer changed while this was being saved. Reload and try again.");
	}
	return { previous, customerId, changed: true, verified: client !== null };
}
