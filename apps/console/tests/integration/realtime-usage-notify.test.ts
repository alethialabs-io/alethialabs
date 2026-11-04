// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6127): what the billing change triggers in lib/db/programmables.sql NOTIFY, that the
// AI ledger does NOT (its producer is the app-layer `emitUsageHint`), and what that hint sends —
// against real Postgres. A mocked database cannot answer this: the property is a trigger's
// WHEN clause meeting writes that change columns nobody renders.
//
// DETERMINISM, as in realtime-notify.test.ts: after each operation the test commits a sentinel
// NOTIFY of its own and waits for it on a dedicated LISTEN connection; everything that arrived
// before the sentinel is exactly what the operation emitted. Notices are kept only when they name
// THIS file's org or user, because other suites write the same tables concurrently. Every zero
// below has a control in the same test that emits one.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	aiCreditGrant,
	aiUsageLedger,
	invoice,
	organization,
	organizationBilling,
} from "@/lib/db/schema";
import { emitUsageHint } from "@/lib/realtime/usage-hint";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const USER = randomUUID();

interface Notice {
	t: string;
	id: string | null;
	o: string | null;
	u: string | null;
	p: string | null;
	n?: string;
}

const db = () => getServiceDb();
let listener: ReturnType<typeof postgres>;
const heard: Notice[] = [];

/** Waits for the sentinel `n`, then returns (and forgets) this file's notices before it. */
async function drainUntil(n: string): Promise<Notice[]> {
	for (let i = 0; i < 200; i++) {
		const at = heard.findIndex((x) => x.t === "_sentinel" && x.n === n);
		if (at >= 0) {
			const before = heard.splice(0, at + 1).slice(0, at);
			return before.filter((x) => x.o === ORG || x.u === USER);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`sentinel ${n} never arrived — the LISTEN connection is not hearing alethia_change`);
}

/** Runs `op` (committed), then returns exactly this file's notices it emitted. */
async function emitted(op: () => Promise<unknown>): Promise<Notice[]> {
	await op();
	const n = randomUUID();
	await db().execute(
		sql`select pg_notify('alethia_change', ${JSON.stringify({ t: "_sentinel", n })})`,
	);
	return drainUntil(n);
}

/** The one notice an org-wide billing/usage change sends: topic + org, no row id. */
const orgNotice = (t: "billing" | "usage"): Notice => ({ t, id: null, o: ORG, u: null, p: null });

describeIfDb("billing and usage change triggers — what reaches alethia_change (#6127)", () => {
	beforeAll(async () => {
		listener = postgres(process.env.ALETHIA_DATABASE_URL ?? "", { max: 1 });
		await listener.listen("alethia_change", (payload) => heard.push(JSON.parse(payload)));
		await db().insert(organization).values({ id: ORG, name: `it-6127-${ORG.slice(0, 8)}` });
	});

	afterAll(async () => {
		await listener?.end({ timeout: 1 });
		await db().delete(aiUsageLedger).where(eq(aiUsageLedger.user_id, USER));
		await db().delete(aiCreditGrant).where(eq(aiCreditGrant.user_id, USER));
		await db().delete(invoice).where(eq(invoice.organizationId, ORG));
		await db().delete(organizationBilling).where(eq(organizationBilling.organizationId, ORG));
		await db().delete(organization).where(eq(organization.id, ORG));
	});

	it("the billing record: one `billing` notice per change a page shows, none otherwise", async () => {
		const byOrg = eq(organizationBilling.organizationId, ORG);
		expect(
			await emitted(() => db().insert(organizationBilling).values({ organizationId: ORG })),
		).toEqual([orgNotice("billing")]);

		// The page's own controls and the Stripe webhook's writes each emit one.
		expect(
			await emitted(() => db().update(organizationBilling).set({ usageHardCap: true }).where(byOrg)),
		).toEqual([orgNotice("billing")]);
		expect(
			await emitted(() =>
				db().update(organizationBilling).set({ aiOrgWeeklyCapCredits: 50_000 }).where(byOrg),
			),
		).toEqual([orgNotice("billing")]);
		// A cancel-at-period-end flip changes no plan column; the event watermark is what moves.
		expect(
			await emitted(() =>
				db().update(organizationBilling).set({ stripeSubscriptionEventAt: new Date() }).where(byOrg),
			),
		).toEqual([orgNotice("billing")]);

		// Writes nobody renders: the welcome-email claim, the bookkeeping clock, a no-op re-write.
		expect(
			await emitted(() => db().update(organizationBilling).set({ welcomedAt: new Date() }).where(byOrg)),
		).toEqual([]);
		expect(
			await emitted(() => db().update(organizationBilling).set({ updatedAt: new Date() }).where(byOrg)),
		).toEqual([]);
		expect(
			await emitted(() => db().update(organizationBilling).set({ usageHardCap: true }).where(byOrg)),
		).toEqual([]);
	});

	it("the invoice mirror: a new invoice and a status change emit; a bookkeeping write does not", async () => {
		const id = randomUUID();
		expect(
			await emitted(() =>
				db().insert(invoice).values({
					id,
					organizationId: ORG,
					stripeInvoiceId: `in_it6127_${id.slice(0, 12)}`,
					status: "paid",
					amountTotal: 2000,
					currency: "usd",
					paidAt: new Date("2026-06-01T00:00:00Z"),
				}),
			),
		).toEqual([orgNotice("billing")]);
		expect(
			await emitted(() => db().update(invoice).set({ updatedAt: new Date() }).where(eq(invoice.id, id))),
		).toEqual([]);
		expect(
			await emitted(() => db().update(invoice).set({ status: "refunded" }).where(eq(invoice.id, id))),
		).toEqual([orgNotice("billing")]);
	});

	// The `usage` topic has no trigger: an AI hold commits inside the AI-budget lock, and a notifying
	// commit serialises with every other one. Its producer is the app-layer hint below.
	it("the AI ledger and credit grants emit NOTHING themselves", async () => {
		expect(
			await emitted(() =>
				db().insert(aiUsageLedger).values({ user_id: USER, org_id: ORG, kind: "agent", credits: 100 }),
			),
		).toEqual([]);
		expect(
			await emitted(() => db().insert(aiCreditGrant).values({ user_id: USER, org_id: ORG, credits: 5000 })),
		).toEqual([]);
	});

	it("emitUsageHint announces once on the org arm, then holds the rest of the window", async () => {
		expect(await emitted(async () => emitUsageHint(ORG))).toEqual([orgNotice("usage")]);
		// Inside the 30 s window: folded into a trailing announcement, nothing now.
		expect(await emitted(async () => emitUsageHint(ORG))).toEqual([]);
	});
});
