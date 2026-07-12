// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): the metered-AI overspend RACE fix — assertAiAllowed's metered branch
// now RESERVES a provisional hold row under a per-org advisory-locked transaction, so N concurrent
// turns can't all read the same pre-settle headroom and blow past the credit cap. Proven end-to-end:
//  1. NON-VACUOUS: the pre-fix logic (a lockless headroom read with no reservation, replicated inline)
//     admits ALL N concurrent turns against room for one — the exact overspend the audit reported.
//  2. THE FIX serializes: the real assertAiAllowed admits only the affordable number; the rest 402.
//  3. The bound is ceil(headroom / reserve) — each admitted turn's hold shrinks the next's headroom.
//  4. recordAiUsage RECONCILES the hold IN PLACE on settle (same row → real cost, no double-charge)
//     and RELEASES it to 0 on an errored/empty turn (no leaked hold that permanently eats headroom).
//  5. recordAgentTurnUsage reconciles the hold on row 0 + appends further model rows; empty → release.
//  6. Included exhausted → the hold is reserved against purchased packs instead.
//  7. LEAK-HARDENING (releaseAiHold): the streaming routes can end a turn WITHOUT a settle — a throw
//     between the gate and streamText (case a) or a client disconnect firing onAbort (case b). Both
//     call releaseAiHold(charge, ctx). Proven non-vacuously: WITHOUT the release the stranded hold
//     stays at the reserve and blocks the next turn (the leak); WITH it the hold drops to 0 in place
//     and headroom is restored so the next turn is re-admitted. No-op for a fixed (scan) charge.
//
// Needs `pnpm db:up` (or any migrated Postgres on ALETHIA_DATABASE_URL); skips when unreachable.

import { randomUUID } from "node:crypto";
import { and, eq, sum } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { recordAgentTurnUsage } from "@/lib/billing/agent-metering";
import {
	type AiCharge,
	AiBudgetError,
	assertAiAllowed,
	METERED_RESERVE_CREDITS,
	releaseAiHold,
} from "@/lib/billing/ai-guard";
import { AI_SESSION_WINDOW_MS, aiTierSpec } from "@/lib/billing/ai-plan";
import {
	grantAiCredits,
	recordAiUsage,
	sumCredits,
} from "@/lib/billing/ai-quota";
import { getServiceDb } from "@/lib/db";
import { aiCreditGrant, aiUsageLedger } from "@/lib/db/schema";
import { describeIfDb } from "./db";

// No organization_billing row ⇒ resolveAiPlan returns { ai_free, hardCap:false }, so these are the
// live caps under test: session 130, weekly 510 credits. The session cap binds first for "now" usage.
const FREE = aiTierSpec("ai_free");

const HAIKU = "anthropic/claude-haiku-4-5";
const SONNET = "anthropic/claude-sonnet-4-6";

// Orgs touched by the suite — cleaned up at the end (each test uses a fresh random org for isolation).
const touchedOrgs: string[] = [];

/** A fresh, isolated org id (tracked for teardown). */
function freshOrg(): string {
	const id = randomUUID();
	touchedOrgs.push(id);
	return id;
}

/** Seed one included-usage row for an org/seat, aged `ageMs` before now. */
async function seedIncludedUsed(
	orgId: string,
	userId: string,
	credits: number,
	ageMs = 0,
): Promise<void> {
	await getServiceDb()
		.insert(aiUsageLedger)
		.values({
			org_id: orgId,
			user_id: userId,
			kind: "agent",
			credits,
			source: "included",
			created_at: new Date(Date.now() - ageMs),
		});
}

/** All ledger rows for an org (newest-agnostic; small in tests). */
async function ledgerRows(orgId: string) {
	return getServiceDb()
		.select()
		.from(aiUsageLedger)
		.where(eq(aiUsageLedger.org_id, orgId));
}

/**
 * The PRE-FIX metered admission, replicated inline: a lockless headroom read with NO reservation
 * written. This is exactly what shipped before — every caller reads the same ledger sum and returns
 * "allowed" because no in-flight hold exists yet. Used to prove the race is real (non-vacuous).
 */
async function preFixAdmit(orgId: string): Promise<boolean> {
	const since = new Date(Date.now() - AI_SESSION_WINDOW_MS);
	const used = await sumCredits(orgId, "included", since);
	return used < FREE.sessionCredits;
}

describeIfDb("assertAiAllowed — metered overspend race", () => {
	beforeAll(() => {
		// isStripeConfigured() only checks STRIPE_SECRET_KEY presence — set it so the guard runs the
		// real budget path instead of the self-host "unlimited" bypass (which would prove nothing).
		process.env.STRIPE_SECRET_KEY ||= "sk_test_race_integration";
	});

	afterAll(async () => {
		const db = getServiceDb();
		for (const org of touchedOrgs) {
			await db.delete(aiUsageLedger).where(eq(aiUsageLedger.org_id, org));
			await db.delete(aiCreditGrant).where(eq(aiCreditGrant.org_id, org));
		}
	});

	it("NON-VACUOUS: the pre-fix lockless check admits ALL N concurrent turns (the overspend)", async () => {
		const org = freshOrg();
		const user = randomUUID();
		// Used 125 of the 130 session cap → headroom 5, room for ONE real turn at most.
		await seedIncludedUsed(org, user, FREE.sessionCredits - 5);
		const N = 50;
		const admitted = await Promise.all(
			Array.from({ length: N }, () => preFixAdmit(org)),
		);
		// Every concurrent caller sees used=125 < 130 and is admitted — free overspend by ~50×.
		expect(admitted.filter(Boolean).length).toBe(N);
	});

	it("THE FIX: only the affordable number of concurrent turns are admitted; the rest 402", async () => {
		const org = freshOrg();
		const user = randomUUID();
		// Same seed as the race demo: used 125 < 130 → exactly ONE hold (100) fits before 225 ≥ 130.
		await seedIncludedUsed(org, user, FREE.sessionCredits - 5);
		const N = 50;
		const settled = await Promise.allSettled(
			Array.from({ length: N }, () => assertAiAllowed(org, "agent", user)),
		);

		const admitted = settled.filter((s) => s.status === "fulfilled");
		const denied = settled.flatMap((s) =>
			s.status === "rejected" ? [s.reason] : [],
		);
		expect(admitted.length).toBe(1);
		expect(denied.length).toBe(N - 1);
		// Every denial is a budget error (not some other failure) — fail-closed.
		for (const reason of denied) {
			expect(reason).toBeInstanceOf(AiBudgetError);
		}

		// Exactly ONE new hold row was written (credits = the reserve), on top of the seed row.
		const rows = await ledgerRows(org);
		const holds = rows.filter((r) => r.credits === METERED_RESERVE_CREDITS);
		expect(holds.length).toBe(1);
		expect(rows.length).toBe(2); // seed + the single hold — no leaked / duplicate holds
	});

	it("admits exactly ceil(headroom / reserve) concurrent turns — the hold bounds the burst", async () => {
		const org = freshOrg();
		const user = randomUUID();
		// Fresh org, no seed: session headroom = 130. With a 100-credit hold each and the `used<cap`
		// check, holds admit while used<130: 0→100 (ok), 100→200 (ok), then 200 stops ⇒ 2 admitted.
		const N = 50;
		const settled = await Promise.allSettled(
			Array.from({ length: N }, () => assertAiAllowed(org, "agent", user)),
		);
		const admitted = settled.filter((s) => s.status === "fulfilled").length;
		const expected = Math.ceil(FREE.sessionCredits / METERED_RESERVE_CREDITS);
		expect(admitted).toBe(expected); // ceil(130/100) = 2

		const rows = await ledgerRows(org);
		expect(rows.filter((r) => r.credits === METERED_RESERVE_CREDITS).length).toBe(
			expected,
		);
	});

	it("reconciles the hold IN PLACE on settle — same row → real cost, no second row", async () => {
		const org = freshOrg();
		const user = randomUUID();
		const charge = await assertAiAllowed(org, "agent", user);
		expect(charge.settle).toBe(true);
		if (!charge.settle) throw new Error("expected a settle charge");

		const before = await ledgerRows(org);
		expect(before.length).toBe(1);
		expect(before[0].credits).toBe(METERED_RESERVE_CREDITS); // the estimate
		expect(before[0].cost_micros).toBeNull(); // not yet reconciled

		await recordAiUsage({
			orgId: org,
			userId: user,
			kind: "agent",
			source: "included",
			holdId: charge.holdId,
			model: HAIKU,
			inputTokens: 1200,
			outputTokens: 600,
		});

		const after = await ledgerRows(org);
		expect(after.length).toBe(1); // UPDATE, not INSERT — no double-charge
		expect(after[0].id).toBe(charge.holdId);
		expect(after[0].model).toBe(HAIKU);
		expect(after[0].cost_micros).toBeGreaterThan(0);
		// A tiny real turn costs far less than the ~$0.10 estimate → the hold shrinks to reality.
		expect(after[0].credits).toBeGreaterThan(0);
		expect(after[0].credits).toBeLessThan(METERED_RESERVE_CREDITS);
		// The window sum now reflects the REAL cost — no lingering estimate.
		expect(await sumCredits(org, "included", new Date(0))).toBe(after[0].credits);
	});

	it("RELEASES the hold to 0 on an errored turn — no leaked headroom", async () => {
		const org = freshOrg();
		const user = randomUUID();
		const charge = await assertAiAllowed(org, "agent", user);
		if (!charge.settle) throw new Error("expected a settle charge");

		// The error path reconciles with no model/tokens → credits 0 (releases the hold).
		await recordAiUsage({
			orgId: org,
			userId: user,
			kind: "agent",
			source: "included",
			holdId: charge.holdId,
		});

		const rows = await ledgerRows(org);
		expect(rows.length).toBe(1);
		expect(rows[0].credits).toBe(0);
		// Headroom is fully restored — the failed turn cost nothing.
		expect(await sumCredits(org, "included", new Date(0))).toBe(0);
	});

	it("recordAgentTurnUsage: reconciles the hold on row 0 and appends further model rows", async () => {
		const org = freshOrg();
		const user = randomUUID();
		const charge = await assertAiAllowed(org, "agent", user);
		if (!charge.settle) throw new Error("expected a settle charge");

		await recordAgentTurnUsage({
			orgId: org,
			userId: user,
			kind: "agent",
			charge,
			refId: "thread-x",
			steps: [
				{ model: SONNET, usage: { inputTokens: 3000, outputTokens: 900 } },
				{ model: HAIKU, usage: { inputTokens: 6000, outputTokens: 1500 } },
			],
		});

		const rows = await ledgerRows(org);
		expect(rows.length).toBe(2); // hold row reconciled (row 0) + one appended model row
		// The hold row is no longer a raw estimate (an unreconciled hold has cost_micros = null).
		const unreconciledHolds = rows.filter(
			(r) => r.credits === METERED_RESERVE_CREDITS && r.cost_micros === null,
		);
		expect(unreconciledHolds.length).toBe(0);
		const reconciledHold = rows.find((r) => r.id === charge.holdId);
		expect(reconciledHold?.cost_micros).toBeGreaterThan(0);
	});

	it("recordAgentTurnUsage: releases the hold on an empty turn (no steps)", async () => {
		const org = freshOrg();
		const user = randomUUID();
		const charge = await assertAiAllowed(org, "agent", user);
		if (!charge.settle) throw new Error("expected a settle charge");

		await recordAgentTurnUsage({
			orgId: org,
			userId: user,
			kind: "agent",
			charge,
			steps: [],
		});

		const rows = await ledgerRows(org);
		expect(rows.length).toBe(1);
		expect(rows[0].credits).toBe(0); // released — not stuck at the reserve estimate
	});

	it("reserves against purchased packs when included headroom is gone", async () => {
		const org = freshOrg();
		const user = randomUUID();
		// Included session exhausted (used == cap, not < cap) → included headroom gone.
		await seedIncludedUsed(org, user, FREE.sessionCredits);
		await grantAiCredits({
			orgId: org,
			userId: user,
			credits: 1000,
			stripeRef: `race-${org}`,
		});

		const charge = await assertAiAllowed(org, "agent", user);
		expect(charge.source).toBe("purchased");
		if (!charge.settle) throw new Error("expected a settle charge");

		const rows = await ledgerRows(org);
		const hold = rows.find((r) => r.id === charge.holdId);
		expect(hold?.source).toBe("purchased");
		expect(hold?.credits).toBe(METERED_RESERVE_CREDITS);
		// The included window sum is untouched by a purchased hold (it draws the other budget).
		const [inc] = await getServiceDb()
			.select({ s: sum(aiUsageLedger.credits) })
			.from(aiUsageLedger)
			.where(
				and(
					eq(aiUsageLedger.org_id, org),
					eq(aiUsageLedger.source, "included"),
				),
			);
		expect(Number(inc?.s ?? 0)).toBe(FREE.sessionCredits);
	});

	// ── Leak-hardening: releaseAiHold on the streaming routes' pre-stream throw / onAbort paths ──

	it("LEAK vs FIX (non-vacuous): a stranded hold blocks the next turn; releaseAiHold restores headroom", async () => {
		const org = freshOrg();
		const user = randomUUID();
		// Seed 40 of the 130 session cap → headroom 90. One 100-credit hold tips the window OVER cap.
		await seedIncludedUsed(org, user, 40);

		// A metered turn reserves its hold, then a throw happens BETWEEN the gate and streamText
		// registration (req.json / model resolution / tool build) — the exact case-(a) window.
		const charge = await assertAiAllowed(org, "agent", user);
		if (!charge.settle) throw new Error("expected a settle charge");

		// THE LEAK (what shipped before this fix): with the hold NOT released, the window sits at
		// 40 + 100 = 140 ≥ 130, so the NEXT turn is wrongly denied — the ≈$0.10 hold ate the headroom.
		expect(await sumCredits(org, "included", new Date(0))).toBe(
			40 + METERED_RESERVE_CREDITS,
		);
		await expect(assertAiAllowed(org, "agent", user)).rejects.toBeInstanceOf(
			AiBudgetError,
		);

		// THE FIX: the route's catch (case a) — identically, onAbort (case b) — calls releaseAiHold,
		// which reconciles the SAME hold row to 0. Headroom drops back to 40 → the next turn is admitted.
		await releaseAiHold(charge, {
			orgId: org,
			userId: user,
			kind: "agent",
			refId: "thread-x",
		});
		expect(await sumCredits(org, "included", new Date(0))).toBe(40);

		const readmitted = await assertAiAllowed(org, "agent", user);
		expect(readmitted.settle).toBe(true);

		// Ledger: seed(40) + the released hold(0, UPDATE in place) + the re-admitted turn's fresh hold(100).
		const rows = await ledgerRows(org);
		expect(rows.length).toBe(3);
		expect(rows.map((r) => r.credits).sort((a, b) => a - b)).toEqual([
			0,
			40,
			METERED_RESERVE_CREDITS,
		]);
	});

	it("releaseAiHold reconciles the hold IN PLACE to 0 (no new row, cost-only null) — the onAbort path", async () => {
		const org = freshOrg();
		const user = randomUUID();
		const charge = await assertAiAllowed(org, "agent", user);
		if (!charge.settle) throw new Error("expected a settle charge");

		// Simulate a client disconnect: onAbort → releaseAiHold, with no tokens/model recorded.
		await releaseAiHold(charge, { orgId: org, userId: user, kind: "agent" });

		const rows = await ledgerRows(org);
		expect(rows.length).toBe(1); // UPDATE, not INSERT
		expect(rows[0].id).toBe(charge.holdId);
		expect(rows[0].credits).toBe(0);
		expect(rows[0].cost_micros).toBeNull(); // released with no model → cost-only null
		expect(await sumCredits(org, "included", new Date(0))).toBe(0);
	});

	it("releaseAiHold is idempotent-safe — a second release keeps the hold at 0", async () => {
		const org = freshOrg();
		const user = randomUUID();
		const charge = await assertAiAllowed(org, "agent", user);
		if (!charge.settle) throw new Error("expected a settle charge");

		// Both the catch AND onAbort could theoretically run; the absolute-value UPDATE makes a double
		// release harmless (last-writer-wins → still 0), and never inserts a duplicate row.
		await releaseAiHold(charge, { orgId: org, userId: user, kind: "agent" });
		await releaseAiHold(charge, { orgId: org, userId: user, kind: "agent" });

		const rows = await ledgerRows(org);
		expect(rows.length).toBe(1);
		expect(rows[0].credits).toBe(0);
	});

	it("releaseAiHold is a no-op for a fixed (scan) charge — it holds no row", async () => {
		const org = freshOrg();
		const user = randomUUID();
		// A fixed charge carries no holdId; releasing it must write nothing to the ledger.
		const fixed: AiCharge = { source: "included", credits: 5 };
		await releaseAiHold(fixed, { orgId: org, userId: user, kind: "scan" });
		expect((await ledgerRows(org)).length).toBe(0);
	});
});
