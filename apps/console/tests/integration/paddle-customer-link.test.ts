// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): the billing-row store behind the staff app's "Link Paddle customer"
// action (lib/platform/paddle-customer.ts). The unit suite proves the decision over an in-memory
// store; this proves the real conditional upsert gives the same answers:
//  1. An org with no billing row gets one holding only the customer id (plan and status defaulted).
//  2. A stored id is replaced only while it is still the expected value; a stale expectation writes
//     nothing.
//  3. Only `paddle_customer_id` moves — the plan and status on an existing row are untouched.
//
// Needs `pnpm db:up` (or any migrated Postgres on ALETHIA_DATABASE_URL); skips when unreachable.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { organization, organizationBilling } from "@/lib/db/schema";
import { postgresPaddleCustomerStore as store } from "@/lib/platform/paddle-customer";
import { describeIfDb } from "./db";

const touchedOrgs: string[] = [];

/** Inserts a fresh organization (tracked for teardown). */
async function seedOrg(): Promise<string> {
	const id = randomUUID();
	touchedOrgs.push(id);
	await getServiceDb().insert(organization).values({ id, name: `ctm-link-it-${id.slice(0, 8)}` });
	return id;
}

/** The org's billing row. */
async function rowOf(orgId: string) {
	const [row] = await getServiceDb()
		.select()
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, orgId))
		.limit(1);
	return row;
}

describeIfDb("postgresPaddleCustomerStore", () => {
	afterAll(async () => {
		if (touchedOrgs.length > 0) {
			await getServiceDb().delete(organization).where(inArray(organization.id, touchedOrgs));
		}
	});

	it("creates a billing row holding only the customer id", async () => {
		const org = await seedOrg();
		expect(await store.orgExists(org)).toBe(true);
		expect(await store.orgExists(randomUUID())).toBe(false);
		expect(await store.current(org)).toBeNull();
		expect(await store.write(org, "ctm_first", null)).toBe(true);
		expect(await rowOf(org)).toMatchObject({ paddleCustomerId: "ctm_first", plan: "community", status: "none" });
	});

	it("replaces only while the stored value is the expected one", async () => {
		const org = await seedOrg();
		await store.write(org, "ctm_first", null);
		expect(await store.write(org, "ctm_second", null)).toBe(false);
		expect(await store.write(org, "ctm_second", "ctm_other")).toBe(false);
		expect(await store.current(org)).toBe("ctm_first");
		expect(await store.write(org, "ctm_second", "ctm_first")).toBe(true);
		expect(await store.current(org)).toBe("ctm_second");
	});

	it("leaves the plan and status of an existing row alone", async () => {
		const org = await seedOrg();
		await getServiceDb()
			.insert(organizationBilling)
			.values({ organizationId: org, plan: "enterprise", status: "active", seats: 12 });
		expect(await store.write(org, "ctm_first", null)).toBe(true);
		expect(await rowOf(org)).toMatchObject({
			paddleCustomerId: "ctm_first",
			plan: "enterprise",
			status: "active",
			seats: 12,
		});
	});
});
