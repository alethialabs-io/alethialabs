// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the AI-credit ledger math against real Postgres — recordAiUsage / grantAiCredits
// write paths feeding sumCredits, aiCreditsSeries, and purchasedBalance (grants − purchased).

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	aiCreditsSeries,
	grantAiCredits,
	purchasedBalance,
	recordAiUsage,
	sumCredits,
} from "@/lib/billing/ai-quota";
import { aiCreditGrant, aiUsageLedger } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const USER = randomUUID();

describeIfDb("ai-quota ledger", () => {
	beforeAll(async () => {
		// Two included-usage rows on different days + one purchased.
		await recordAiUsage({
			orgId: ORG,
			userId: USER,
			kind: "scan",
			credits: 20,
			source: "included",
		});
		await recordAiUsage({
			orgId: ORG,
			userId: USER,
			kind: "agent",
			credits: 5,
			source: "purchased",
		});
		// A purchased grant of 500.
		await grantAiCredits({ orgId: ORG, userId: USER, credits: 500, stripeRef: `it-${ORG}` });
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(aiUsageLedger).where(eq(aiUsageLedger.org_id, ORG));
		await db.delete(aiCreditGrant).where(eq(aiCreditGrant.org_id, ORG));
	});

	it("sums included credits since a cutoff", async () => {
		const used = await sumCredits(ORG, "included", new Date(0));
		expect(used).toBe(20);
	});

	it("computes the purchased balance as grants − purchased usage", async () => {
		// 500 granted − 5 purchased-source usage = 495.
		expect(await purchasedBalance(ORG)).toBe(495);
	});

	it("buckets consumed credits by day", async () => {
		const series = await aiCreditsSeries(
			ORG,
			new Date(Date.now() - 7 * 24 * 3600 * 1000),
			new Date(Date.now() + 24 * 3600 * 1000),
		);
		const total = series.reduce((n, r) => n + r.credits, 0);
		expect(total).toBe(25); // 20 included + 5 purchased, both within the window
	});

	it("is idempotent on the Stripe ref for grants", async () => {
		await grantAiCredits({ orgId: ORG, userId: USER, credits: 999, stripeRef: `it-${ORG}` });
		// The duplicate ref is ignored → balance unchanged.
		expect(await purchasedBalance(ORG)).toBe(495);
	});
});
