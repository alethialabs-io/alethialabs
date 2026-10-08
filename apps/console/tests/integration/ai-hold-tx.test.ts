// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): AI billing on ONE transaction — ADR 0003 slice 3 (§5.1 step 7,
// §5.3, §8.1). The chat-turn claim (slice 5) reserves its hold and settles its answer inside its
// own transactions, so the billing primitives must run on a caller's `tx`:
//  1. reserveAiHold(tx, …) writes the hold on the caller's transaction: it commits with the
//     caller's other writes and vanishes with their rollback.
//  2. It reads the plan on `tx`, after its lock: a billing row the same transaction wrote (and no
//     pooled connection can see yet) decides the caps.
//  3. A refusal is returned as data. Nothing is written, the transaction is still usable, and the
//     AiBudgetError is built only after it ends.
//  4. It is re-entrant under the caller's own advisory lock, and N concurrent tx-path reserves are
//     still serialized to exactly what fits.
//  5. recordAgentTurnUsage(…, tx) settles on the caller's transaction: rolled back, the hold is
//     still the unsettled reserve and no model row was appended; committed, it is settled.
//  6. floorCredits is applied to the SUM of a multi-model attempt's rows by raising row 0.
//  7. The side effects run only when the caller runs the after-commit, after its commit — never
//     inside the transaction, never after a rollback.
//
// Needs a migrated Postgres on ALETHIA_DATABASE_URL (CI's Integration job); skips when unreachable.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

// The spend alert reads the ledger on a pooled connection; spy on it to see WHEN it runs.
vi.mock("@/lib/billing/ai-spend-alert", () => ({
	checkAiSpendThreshold: vi.fn(() => Promise.resolve()),
}));

import { recordAgentTurnUsage } from "@/lib/billing/agent-metering";
import {
	AiBudgetError,
	type AiHoldDecision,
	aiBudgetRefusalError,
	assertAiAllowed,
	METERED_RESERVE_CREDITS,
	reserveAiHold,
} from "@/lib/billing/ai-guard";
import { aiTierSpec, resolveAiPlan } from "@/lib/billing/ai-plan";
import { settleCredits, sumCredits } from "@/lib/billing/ai-quota";
import { checkAiSpendThreshold } from "@/lib/billing/ai-spend-alert";
import { getServiceDb, type Tx } from "@/lib/db";
import { aiUsageLedger, organization, organizationBilling } from "@/lib/db/schema";
import { describeIfDb } from "./db";

// No organization_billing row ⇒ ai_free: session 130, weekly 510.
const FREE = aiTierSpec("ai_free");

const HAIKU = "anthropic/claude-haiku-4-5";
const SONNET = "anthropic/claude-sonnet-4-6";

const touchedOrgs: string[] = [];

/** A fresh, isolated org id (tracked for teardown). */
function freshOrg(): string {
	const id = randomUUID();
	touchedOrgs.push(id);
	return id;
}

/** Thrown inside a transaction to roll it back on purpose. */
class Rollback extends Error {}

/** Run `fn` on a service transaction and roll it back; resolves to what `fn` returned. */
async function inRolledBackTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
	let out: { value: T } | undefined;
	await getServiceDb()
		.transaction(async (tx) => {
			out = { value: await fn(tx) };
			throw new Rollback();
		})
		.catch((e: unknown) => {
			if (!(e instanceof Rollback)) throw e;
		});
	if (!out) throw new Error("the transaction body did not finish");
	return out.value;
}

/** Seed one committed included-usage row for an org/seat. */
async function seedIncludedUsed(orgId: string, userId: string, credits: number) {
	await getServiceDb().insert(aiUsageLedger).values({
		org_id: orgId,
		user_id: userId,
		kind: "agent",
		credits,
		source: "included",
	});
}

/** All committed ledger rows for an org. */
async function ledgerRows(orgId: string) {
	return getServiceDb()
		.select()
		.from(aiUsageLedger)
		.where(eq(aiUsageLedger.org_id, orgId));
}

/** The hold id of a decision that must have been a charge. */
function holdIdOf(decision: AiHoldDecision): string {
	if (decision.outcome !== "charge") {
		throw new Error(`expected a charge, got ${JSON.stringify(decision)}`);
	}
	return decision.charge.holdId;
}

describeIfDb("AI billing on one transaction (ADR 0003 slice 3)", () => {
	beforeAll(() => {
		// The hosted-billing path (isStripeConfigured() checks the key's presence).
		process.env.STRIPE_SECRET_KEY ||= "sk_test_ai_hold_tx_integration";
	});

	beforeEach(() => {
		vi.mocked(checkAiSpendThreshold).mockClear();
	});

	afterAll(async () => {
		const db = getServiceDb();
		for (const org of touchedOrgs) {
			await db.delete(aiUsageLedger).where(eq(aiUsageLedger.org_id, org));
		}
	});

	it("reserveAiHold on the caller's tx commits with the caller's other writes", async () => {
		const org = freshOrg();
		const user = randomUUID();
		const holdId = await getServiceDb().transaction(async (tx) => {
			const decision = await reserveAiHold(tx, org, "agent", user);
			// The caller's own write in the same transaction (standing in for the turn claim).
			await tx.insert(aiUsageLedger).values({
				org_id: org,
				user_id: user,
				kind: "agent",
				credits: 7,
				source: "included",
			});
			return holdIdOf(decision);
		});
		const rows = await ledgerRows(org);
		expect(rows).toHaveLength(2);
		const hold = rows.find((r) => r.id === holdId);
		expect(hold?.credits).toBe(METERED_RESERVE_CREDITS);
		expect(hold?.settled_at).toBeNull();
	});

	it("a rolled-back caller leaves no hold, and the next turn sees the whole headroom", async () => {
		const org = freshOrg();
		const user = randomUUID();
		const holdId = await inRolledBackTx(async (tx) =>
			holdIdOf(await reserveAiHold(tx, org, "agent", user)),
		);
		expect(holdId).toMatch(/[0-9a-f-]{36}/);
		expect(await ledgerRows(org)).toHaveLength(0);
		// Nothing stranded: the pooled gate admits the full ceil(130/100) = 2 turns afterwards.
		await assertAiAllowed(org, "agent", user);
		await assertAiAllowed(org, "agent", user);
		await expect(assertAiAllowed(org, "agent", user)).rejects.toBeInstanceOf(
			AiBudgetError,
		);
	});

	it("reads the plan on the tx: a billing row this transaction wrote decides the caps", async () => {
		const org = freshOrg();
		const user = randomUUID();
		await inRolledBackTx(async (tx) => {
			await tx.insert(organization).values({ id: org, name: `it-hold-tx-${org.slice(0, 6)}` });
			await tx.insert(organizationBilling).values({
				organizationId: org,
				aiTier: "ai_plus",
				aiSubscriptionStatus: "active",
			});
			// 200 used: past ai_free's 130 session cap, well inside ai_plus's.
			await tx.insert(aiUsageLedger).values({
				org_id: org,
				user_id: user,
				kind: "agent",
				credits: 200,
				source: "included",
			});
			// Non-vacuous: a pooled read cannot see the uncommitted row and answers the free tier.
			expect((await resolveAiPlan(org)).tier).toBe("ai_free");
			expect((await resolveAiPlan(org, tx)).tier).toBe("ai_plus");

			const decision = await reserveAiHold(tx, org, "agent", user);
			expect(decision.outcome).toBe("charge");
		});
	});

	it("a refusal is data: nothing written, the tx still usable, the error built after it ends", async () => {
		const org = freshOrg();
		const user = randomUUID();
		await seedIncludedUsed(org, user, FREE.sessionCredits); // the session is spent

		const decision = await getServiceDb().transaction(async (tx) => {
			const d = await reserveAiHold(tx, org, "agent", user);
			// The transaction is not aborted: the caller can keep using it after a refusal.
			const [{ one }] = await tx.execute<{ one: number }>(sql`select 1 as one`);
			expect(Number(one)).toBe(1);
			return d;
		});
		expect(decision.outcome).toBe("refused");
		if (decision.outcome !== "refused") return;
		// The org's session is spent (and the seat's with it): the org cap binds, no packs to fall to.
		expect(decision.refusal).toMatchObject({ reason: "org", weeklyHit: false });

		expect(await ledgerRows(org)).toHaveLength(1); // the seed alone — no hold row
		const err = await aiBudgetRefusalError(org, user, decision.refusal);
		expect(err).toBeInstanceOf(AiBudgetError);
		expect(err.reason).toBe("session");
		expect(err.resetAt).not.toBeNull();
	});

	it("is re-entrant under the caller's own advisory lock (reserveTurn takes it first)", async () => {
		const org = freshOrg();
		const user = randomUUID();
		await getServiceDb().transaction(async (tx) => {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext('ai_budget'), hashtext(${org}))`,
			);
			holdIdOf(await reserveAiHold(tx, org, "agent", user));
		});
		expect(await ledgerRows(org)).toHaveLength(1);
	});

	it("N concurrent tx-path reserves are serialized: exactly ceil(130 / 100) are admitted", async () => {
		const org = freshOrg();
		const user = randomUUID();
		const N = 20;
		const decisions = await Promise.all(
			Array.from({ length: N }, () =>
				getServiceDb().transaction((tx) => reserveAiHold(tx, org, "agent", user)),
			),
		);
		const admitted = decisions.filter((d) => d.outcome === "charge").length;
		expect(admitted).toBe(Math.ceil(FREE.sessionCredits / METERED_RESERVE_CREDITS));
		expect(await ledgerRows(org)).toHaveLength(admitted);
	});

	it("recordAgentTurnUsage on a rolled-back tx: the hold is still the unsettled reserve, no row appended", async () => {
		const org = freshOrg();
		const user = randomUUID();
		const charge = await assertAiAllowed(org, "agent", user);
		if (!charge.settle) throw new Error("expected a settle charge");

		await inRolledBackTx((tx) =>
			recordAgentTurnUsage(
				{
					orgId: org,
					userId: user,
					kind: "agent",
					charge,
					steps: [
						{ model: SONNET, usage: { inputTokens: 3000, outputTokens: 900 } },
						{ model: HAIKU, usage: { inputTokens: 6000, outputTokens: 1500 } },
					],
				},
				tx,
			),
		);
		const rows = await ledgerRows(org);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(charge.holdId);
		expect(rows[0].credits).toBe(METERED_RESERVE_CREDITS);
		expect(rows[0].settled_at).toBeNull();
		expect(rows[0].cost_micros).toBeNull();
	});

	it("recordAgentTurnUsage on a committed tx settles row 0 and appends the other model's row", async () => {
		const org = freshOrg();
		const user = randomUUID();
		const charge = await assertAiAllowed(org, "agent", user);
		if (!charge.settle) throw new Error("expected a settle charge");

		await getServiceDb().transaction((tx) =>
			recordAgentTurnUsage(
				{
					orgId: org,
					userId: user,
					kind: "agent",
					charge,
					refId: "thread-x",
					steps: [
						{ model: SONNET, usage: { inputTokens: 3000, outputTokens: 900 } },
						{ model: HAIKU, usage: { inputTokens: 6000, outputTokens: 1500 } },
					],
				},
				tx,
			),
		);
		const rows = await ledgerRows(org);
		expect(rows).toHaveLength(2);
		for (const r of rows) expect(r.settled_at).not.toBeNull();
		expect(rows.find((r) => r.id === charge.holdId)?.model).toBe(SONNET);
	});

	it("floorCredits raises row 0 so a multi-model attempt's rows SUM to the floor", async () => {
		const org = freshOrg();
		const user = randomUUID();
		const charge = await assertAiAllowed(org, "agent", user);
		if (!charge.settle) throw new Error("expected a settle charge");

		const steps = [
			{ model: SONNET, usage: { inputTokens: 1000, outputTokens: 200 } },
			{ model: HAIKU, usage: { inputTokens: 2000, outputTokens: 300 } },
		];
		const sonnet = settleCredits({ model: SONNET, inputTokens: 1000, outputTokens: 200 });
		const haiku = settleCredits({ model: HAIKU, inputTokens: 2000, outputTokens: 300 });
		// Non-vacuous: both rows have a real cost, and together they are under the reserve.
		expect(sonnet).toBeGreaterThan(0);
		expect(haiku).toBeGreaterThan(0);
		expect(sonnet + haiku).toBeLessThan(METERED_RESERVE_CREDITS);

		await getServiceDb().transaction((tx) =>
			recordAgentTurnUsage(
				{
					orgId: org,
					userId: user,
					kind: "agent",
					charge,
					steps,
					floorCredits: METERED_RESERVE_CREDITS,
				},
				tx,
			),
		);
		const rows = await ledgerRows(org);
		expect(rows).toHaveLength(2);
		const row0 = rows.find((r) => r.id === charge.holdId);
		const appended = rows.find((r) => r.id !== charge.holdId);
		// The appended row keeps its own real cost; row 0 carries the whole shortfall.
		expect(appended?.credits).toBe(haiku);
		expect(row0?.credits).toBe(METERED_RESERVE_CREDITS - haiku);
		expect(row0?.cost_micros).toBeGreaterThan(0); // still a real model row, not a bare hold
		expect(await sumCredits(org, "included", new Date(0))).toBe(METERED_RESERVE_CREDITS);
	});

	it("floorCredits settles an attempt with no completed step AT the floor", async () => {
		const org = freshOrg();
		const user = randomUUID();
		const charge = await assertAiAllowed(org, "agent", user);
		if (!charge.settle) throw new Error("expected a settle charge");

		await getServiceDb().transaction((tx) =>
			recordAgentTurnUsage(
				{
					orgId: org,
					userId: user,
					kind: "agent",
					charge,
					steps: [],
					floorCredits: METERED_RESERVE_CREDITS,
				},
				tx,
			),
		);
		const rows = await ledgerRows(org);
		expect(rows).toHaveLength(1);
		expect(rows[0].credits).toBe(METERED_RESERVE_CREDITS);
		expect(rows[0].settled_at).not.toBeNull(); // settled, so the sweep never releases it to 0
	});

	it("side effects run only after the caller's commit: not inside the tx, and not on a rollback", async () => {
		const org = freshOrg();
		const user = randomUUID();
		const steps = [{ model: HAIKU, usage: { inputTokens: 1200, outputTokens: 600 } }];

		// Rolled back: the caller never runs the after-commit, so no alert check is made.
		const rolledBack = await assertAiAllowed(org, "agent", user);
		if (!rolledBack.settle) throw new Error("expected a settle charge");
		await inRolledBackTx(async (tx) => {
			await recordAgentTurnUsage(
				{ orgId: org, userId: user, kind: "agent", charge: rolledBack, steps },
				tx,
			);
			expect(checkAiSpendThreshold).not.toHaveBeenCalled();
		});
		expect(checkAiSpendThreshold).not.toHaveBeenCalled();

		// Committed: nothing inside the transaction; the after-commit runs it, against the settled row.
		const charge = await assertAiAllowed(org, "agent", user);
		if (!charge.settle) throw new Error("expected a settle charge");
		const afterCommit = await getServiceDb().transaction(async (tx) => {
			const after = await recordAgentTurnUsage(
				{ orgId: org, userId: user, kind: "agent", charge, steps },
				tx,
			);
			expect(checkAiSpendThreshold).not.toHaveBeenCalled();
			return after;
		});
		expect(checkAiSpendThreshold).not.toHaveBeenCalled();
		afterCommit();
		expect(checkAiSpendThreshold).toHaveBeenCalledTimes(1);
		expect(checkAiSpendThreshold).toHaveBeenCalledWith(org);
		const settled = (await ledgerRows(org)).find((r) => r.id === charge.holdId);
		expect(settled?.settled_at).not.toBeNull();
	});
});
