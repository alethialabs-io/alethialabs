// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): the Paddle overage sweeper's store (lib/billing/paddle/overage-sweeper.ts
// `postgresOverageStore`). The unit suite proves the sweep's rules over an in-memory store that
// imitates the ledger; this proves the real table gives the same answers:
//  1. The claim is the unique key: concurrent inserts for one (subscription, period) leave ONE row,
//     and every loser gets null.
//  2. A due Paddle subscription is a candidate until its period has a row, and only within the lead
//     window; a Stripe or not-yet-due row never is.
//  3. Re-claiming a stale claim is a compare-and-set (one winner), and settling is conditional on
//     the row still being claimed (a late pass never overwrites a settled row).
//
// Needs `pnpm db:up` (or any migrated Postgres on ALETHIA_DATABASE_URL); skips when unreachable.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { type NewUsageCharge, OVERAGE_LEAD_MS, postgresOverageStore } from "@/lib/billing/paddle/overage-sweeper";
import { getServiceDb } from "@/lib/db";
import { organization, organizationBilling, usageCharge } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const touchedOrgs: string[] = [];
const NOW = new Date(Date.UTC(2026, 10, 25, 12, 0, 0));
const START = new Date(Date.UTC(2026, 9, 25, 15, 0, 0));
const END = new Date(NOW.getTime() + 3 * 60 * 60 * 1000); // inside the 6h lead window

/** A unique Paddle-style id. */
function pid(prefix: string): string {
	return `${prefix}_it${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** An org with a Paddle (or Stripe) Pro subscription whose period ends at `end`. */
async function seed(opts: { end?: Date; provider?: "paddle" | "stripe" } = {}): Promise<{ org: string; sub: string }> {
	const org = randomUUID();
	touchedOrgs.push(org);
	const sub = pid("sub");
	const db = getServiceDb();
	await db.insert(organization).values({ id: org, name: `overage-it-${org.slice(0, 8)}` });
	await db.insert(organizationBilling).values({
		organizationId: org,
		plan: "team",
		status: "active",
		billingProvider: opts.provider ?? "paddle",
		...(opts.provider === "stripe" ? { stripeSubscriptionId: sub } : { paddleSubscriptionId: sub }),
		currentPeriodStart: START,
		currentPeriodEnd: opts.end ?? END,
	});
	return { org, sub };
}

/** A claim row for the org's period. */
function claim(org: string, sub: string): NewUsageCharge {
	return {
		organizationId: org,
		subscriptionId: sub,
		periodStart: START,
		periodEnd: END,
		overageMinutes: 250,
		amountMinor: 275,
		currency: "eur",
		status: "claimed",
		error: null,
	};
}

describeIfDb("Paddle overage store over Postgres", () => {
	afterAll(async () => {
		if (touchedOrgs.length > 0) await getServiceDb().delete(organization).where(inArray(organization.id, touchedOrgs));
	});

	it("concurrent claims for one period leave exactly one row", async () => {
		const { org, sub } = await seed();
		const results = await Promise.all(Array.from({ length: 5 }, () => postgresOverageStore.insert(claim(org, sub), NOW)));
		expect(results.filter((r) => r !== null)).toHaveLength(1);
		const rows = await getServiceDb().select().from(usageCharge).where(eq(usageCharge.subscriptionId, sub));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ provider: "paddle", sequence: 0, status: "claimed", amountMinor: 275 });
	});

	it("a due Paddle subscription is a candidate until its period has a row", async () => {
		const due = await seed();
		const later = await seed({ end: new Date(NOW.getTime() + OVERAGE_LEAD_MS + 60 * 60 * 1000) });
		const stripe = await seed({ provider: "stripe" });
		const subsOf = async () => (await postgresOverageStore.candidates(NOW, OVERAGE_LEAD_MS, 1000)).map((c) => c.subscriptionId);

		const before = await subsOf();
		expect(before).toContain(due.sub);
		expect(before).not.toContain(later.sub);
		expect(before).not.toContain(stripe.sub);

		await postgresOverageStore.insert({ ...claim(due.org, due.sub), status: "waived", error: "test" }, NOW);
		expect(await subsOf()).not.toContain(due.sub);
	});

	it("re-claim is compare-and-set and settling is conditional on 'claimed'", async () => {
		const { org, sub } = await seed();
		const row = await postgresOverageStore.insert(claim(org, sub), NOW);
		if (!row) throw new Error("claim failed");
		const later = new Date(NOW.getTime() + 20 * 60 * 1000);
		const cutoff = new Date(later.getTime() - 15 * 60 * 1000);

		expect((await postgresOverageStore.staleClaims(cutoff, 1000)).map((r) => r.id)).toContain(row.id);
		const wins = await Promise.all([postgresOverageStore.reclaim(row.id, cutoff, later), postgresOverageStore.reclaim(row.id, cutoff, later)]);
		expect(wins.filter(Boolean)).toHaveLength(1);

		expect(await postgresOverageStore.settle(row.id, { status: "posted" }, later)).toBe(true);
		expect(await postgresOverageStore.settle(row.id, { status: "failed", error: "late" }, later)).toBe(false);
		await postgresOverageStore.markReconciled(row.id, "pri_it", later);
		const [after] = await getServiceDb().select().from(usageCharge).where(eq(usageCharge.id, row.id));
		expect(after).toMatchObject({ status: "reconciled", providerRef: "pri_it", error: null });
	});
});
