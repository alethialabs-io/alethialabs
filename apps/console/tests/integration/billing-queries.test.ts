// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the per-org billing reads (lib/billing/queries.ts) against real Postgres —
// the WHERE-by-organization_id filtering, the row→typed-column mapping (plan/status/seats/
// stripe ids/period end), and the stripe-customer lookup. Seeds organization + billing rows
// via the service connection (bypasses RLS) with unique ids and cleans up by those ids.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { organization, organizationBilling } from "@/lib/db/schema";
import { getOrgBilling, getOrgByStripeCustomer } from "@/lib/billing/queries";
import { describeIfDb } from "./db";

// Three orgs: A has a live Team subscription, B has a canceled Enterprise row,
// C exists but has NO billing row (→ getOrgBilling must return null).
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ORG_C = randomUUID();
const ORG_IDS = [ORG_A, ORG_B, ORG_C];

const STRIPE_CUSTOMER_A = `cus_test_${ORG_A.slice(0, 8)}`;
const STRIPE_SUB_A = `sub_test_${ORG_A.slice(0, 8)}`;
const PERIOD_END_A = new Date("2026-12-31T00:00:00Z");

describeIfDb("billing queries (getOrgBilling + billing row SQL)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		// organization_billing.organization_id FKs organization.id (cascade) → seed orgs first.
		await db.insert(organization).values([
			{ id: ORG_A, name: `it-bill-a-${ORG_A.slice(0, 6)}` },
			{ id: ORG_B, name: `it-bill-b-${ORG_B.slice(0, 6)}` },
			{ id: ORG_C, name: `it-bill-c-${ORG_C.slice(0, 6)}` },
		]);
		await db.insert(organizationBilling).values([
			{
				organizationId: ORG_A,
				plan: "team",
				status: "active",
				stripeCustomerId: STRIPE_CUSTOMER_A,
				stripeSubscriptionId: STRIPE_SUB_A,
				seats: 5,
				currentPeriodEnd: PERIOD_END_A,
			},
			{
				organizationId: ORG_B,
				plan: "enterprise",
				status: "canceled",
			},
			// ORG_C deliberately has no billing row.
		]);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db
			.delete(organizationBilling)
			.where(inArray(organizationBilling.organizationId, ORG_IDS));
		await db.delete(organization).where(inArray(organization.id, ORG_IDS));
	});

	it("returns the org's billing row mapped onto typed columns", async () => {
		const row = await getOrgBilling(ORG_A);
		expect(row).not.toBeNull();
		expect(row?.organizationId).toBe(ORG_A);
		expect(row?.plan).toBe("team");
		expect(row?.status).toBe("active");
		expect(row?.seats).toBe(5);
		expect(row?.stripeCustomerId).toBe(STRIPE_CUSTOMER_A);
		expect(row?.stripeSubscriptionId).toBe(STRIPE_SUB_A);
		expect(row?.currentPeriodEnd?.toISOString()).toBe(
			PERIOD_END_A.toISOString(),
		);
		// Columns with table defaults / unset values map through correctly.
		expect(row?.usageHardCap).toBe(false);
		expect(row?.currentPeriodStart).toBeNull();
	});

	it("filters strictly by organization_id (returns the right org's row, not a neighbour's)", async () => {
		const a = await getOrgBilling(ORG_A);
		const b = await getOrgBilling(ORG_B);
		expect(a?.organizationId).toBe(ORG_A);
		expect(b?.organizationId).toBe(ORG_B);
		// Distinct rows: A's plan/status must not bleed into B's.
		expect(b?.plan).toBe("enterprise");
		expect(b?.status).toBe("canceled");
		// Unset stripe / seats columns are null for B (no subscription).
		expect(b?.seats).toBeNull();
		expect(b?.stripeCustomerId).toBeNull();
		expect(b?.stripeSubscriptionId).toBeNull();
		expect(b?.currentPeriodEnd).toBeNull();
	});

	it("returns null for an org with no billing row (→ implicitly community)", async () => {
		expect(await getOrgBilling(ORG_C)).toBeNull();
	});

	it("returns null for an org id that doesn't exist at all", async () => {
		expect(await getOrgBilling(randomUUID())).toBeNull();
	});

	it("getOrgByStripeCustomer maps a stripe customer id back to its single org", async () => {
		const row = await getOrgByStripeCustomer(STRIPE_CUSTOMER_A);
		expect(row?.organizationId).toBe(ORG_A);
		expect(row?.plan).toBe("team");
	});

	it("getOrgByStripeCustomer returns null for an unknown customer id", async () => {
		expect(await getOrgByStripeCustomer(`cus_nope_${randomUUID()}`)).toBeNull();
	});
});
