// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Paddle overage sweeper (lib/billing/paddle/overage-sweeper.ts) over an in-memory store that
// keeps the ledger's real rules: one row per (subscription, period start) — a second insert does
// nothing — and every settle is conditional on the row still being `claimed`. What is proven:
//   · claim before call, one charge per period, also when two passes run at once;
//   · an unknown outcome leaves the row claimed and the next pass LOOKS before it posts again;
//   · a refusal fails the row and pages the operator; a lookup that fails re-posts nothing;
//   · O9: a final cancellation charges immediately at ≥ €5 and waives below it;
//   · inside the allowance costs no Paddle call; past-due waits, then pages.

import { describe, expect, it, vi } from "vitest";
import { PaddleApiError } from "@/lib/billing/paddle/api";
import type { ChargeableSubscription, FoundCharge } from "@/lib/billing/paddle/overage";
import {
	type NewUsageCharge,
	type OverageCandidate,
	type OverageStore,
	type OverageSweepDeps,
	paddleOverageSweepEnabled,
	runPaddleOverageSweep,
	STALE_CLAIM_MS,
	UNCONFIRMED_GIVE_UP_MS,
} from "@/lib/billing/paddle/overage-sweeper";
import type { UsageChargeRequest } from "@/lib/billing/provider/types";
import type { UsageCharge } from "@/lib/db/schema";

const START = new Date("2026-11-01T00:00:00Z");
const END = new Date("2026-12-01T00:00:00Z");
/** Three hours before the period ends — inside the lead window. */
const NOW = new Date(END.getTime() - 3 * 60 * 60 * 1000);

/** An in-memory ledger with the real table's uniqueness and compare-and-set rules. */
class MemoryStore implements OverageStore {
	rows: UsageCharge[] = [];
	cands: OverageCandidate[] = [];
	used = 0;
	private seq = 0;

	async candidates(): Promise<OverageCandidate[]> {
		return this.cands.filter(
			(c) => !this.rows.some((r) => r.subscriptionId === c.subscriptionId && r.periodStart.getTime() === c.currentPeriodStart.getTime()),
		);
	}
	async usedMinutes(): Promise<number> {
		return this.used;
	}
	async insert(row: NewUsageCharge, now: Date): Promise<UsageCharge | null> {
		if (this.rows.some((r) => r.subscriptionId === row.subscriptionId && r.periodStart.getTime() === row.periodStart.getTime())) {
			return null;
		}
		const full: UsageCharge = {
			id: `uc-${++this.seq}`,
			provider: "paddle",
			sequence: 0,
			providerRef: null,
			claimedAt: now,
			postedAt: null,
			createdAt: now,
			updatedAt: now,
			...row,
		};
		this.rows.push(full);
		return full;
	}
	async staleClaims(before: Date): Promise<UsageCharge[]> {
		return this.rows.filter((r) => r.status === "claimed" && r.claimedAt < before).map((r) => ({ ...r }));
	}
	async reclaim(id: string, before: Date, now: Date): Promise<boolean> {
		const r = this.rows.find((x) => x.id === id);
		if (!r || r.status !== "claimed" || !(r.claimedAt < before)) return false;
		r.claimedAt = now;
		return true;
	}
	async settle(
		id: string,
		o: { status: "posted" | "reconciled" | "failed"; providerRef?: string | null; error?: string | null },
		now: Date,
	): Promise<boolean> {
		const r = this.rows.find((x) => x.id === id);
		if (!r || r.status !== "claimed") return false;
		r.status = o.status;
		r.providerRef = o.providerRef ?? null;
		r.error = o.error ?? null;
		r.postedAt = o.status === "failed" ? null : now;
		return true;
	}
	async markReconciled(id: string, providerRef: string): Promise<void> {
		const r = this.rows.find((x) => x.id === id);
		if (r?.status === "posted") {
			r.status = "reconciled";
			r.providerRef = providerRef;
		}
	}
}

/** A Paddle subscription matching the candidate's period. */
function paddleSub(over: Partial<ChargeableSubscription> = {}): ChargeableSubscription {
	return {
		id: "sub_1",
		status: "active",
		currency_code: "EUR",
		current_billing_period: { starts_at: START, ends_at: END },
		scheduled_change: null,
		next_transaction: null,
		...over,
	};
}

/** The test harness: a store with one Pro candidate, a fake Paddle, recorded alerts. */
function harness(opts: { used?: number; sub?: ChargeableSubscription; candidate?: Partial<OverageCandidate> } = {}) {
	const store = new MemoryStore();
	store.used = opts.used ?? 750; // Pro includes 500 → 250 over → €2.75
	store.cands = [
		{
			organizationId: "org-1",
			subscriptionId: "sub_1",
			plan: "team",
			status: "active",
			billingProvider: "paddle",
			currentPeriodStart: START,
			currentPeriodEnd: END,
			cancelEffectiveAt: null,
			...opts.candidate,
		},
	];
	/** Charges Paddle holds, by usage-charge id → where it was found. */
	const held = new Map<string, FoundCharge>();
	const posts: UsageChargeRequest[] = [];
	const getSubscription = vi.fn(async (_id: string) => opts.sub ?? paddleSub());
	const post = vi.fn(async (c: UsageChargeRequest) => {
		posts.push(c);
		held.set(c.usageChargeId, { providerRef: c.immediate ? "txn_now" : "pri_next" });
	});
	const find = vi.fn(async (_sub: string, id: string) => held.get(id) ?? null);
	const alerts: string[] = [];
	const deps: OverageSweepDeps = {
		store,
		paddle: { getSubscription, post, find },
		alert: async (a) => {
			alerts.push(a.title);
		},
		log: () => {},
	};
	return { store, deps, posts, post, find, getSubscription, held, alerts };
}

describe("paddleOverageSweepEnabled", () => {
	it("needs the flag AND a Paddle key", () => {
		expect(paddleOverageSweepEnabled({ ALETHIA_PADDLE_OVERAGE_SWEEP: "1", PADDLE_API_KEY: "pdl_sdbx_apikey_x" })).toBe(true);
		expect(paddleOverageSweepEnabled({ ALETHIA_PADDLE_OVERAGE_SWEEP: "true", PADDLE_API_KEY: "pdl_sdbx_apikey_x" })).toBe(true);
		expect(paddleOverageSweepEnabled({ ALETHIA_PADDLE_OVERAGE_SWEEP: "1" })).toBe(false);
		expect(paddleOverageSweepEnabled({ ALETHIA_PADDLE_OVERAGE_SWEEP: "0", PADDLE_API_KEY: "pdl_sdbx_apikey_x" })).toBe(false);
		expect(paddleOverageSweepEnabled({ PADDLE_API_KEY: "pdl_sdbx_apikey_x" })).toBe(false);
	});
});

describe("new charges", () => {
	it("claims the period, posts ONE charge on the next renewal, and reconciles it", async () => {
		const h = harness();
		const result = await runPaddleOverageSweep(NOW, h.deps);
		expect(h.posts).toHaveLength(1);
		expect(h.posts[0]).toMatchObject({ subscriptionId: "sub_1", overageMinutes: 250, amount: { minor: 275, currency: "eur" }, immediate: false });
		expect(h.store.rows).toHaveLength(1);
		expect(h.store.rows[0]).toMatchObject({ status: "reconciled", providerRef: "pri_next", amountMinor: 275, currency: "eur" });
		expect(result.reconciled).toBe(1);

		// A second pass finds the period settled: nothing is posted again.
		await runPaddleOverageSweep(new Date(NOW.getTime() + STALE_CLAIM_MS * 2), h.deps);
		expect(h.posts).toHaveLength(1);
	});

	it("stays 'posted' when the charge is accepted but the lookup cannot see it yet", async () => {
		const h = harness();
		h.find.mockResolvedValueOnce(null);
		await runPaddleOverageSweep(NOW, h.deps);
		expect(h.store.rows[0].status).toBe("posted");
	});

	it("posts once when two passes run at once (the claim is the idempotency)", async () => {
		const h = harness();
		await Promise.all([runPaddleOverageSweep(NOW, h.deps), runPaddleOverageSweep(NOW, h.deps)]);
		expect(h.posts).toHaveLength(1);
		expect(h.store.rows).toHaveLength(1);
	});

	it("costs no Paddle call and writes no row under or at the allowance", async () => {
		for (const used of [100, 500]) {
			const h = harness({ used });
			const result = await runPaddleOverageSweep(NOW, h.deps);
			expect(h.getSubscription).not.toHaveBeenCalled();
			expect(h.store.rows).toHaveLength(0);
			expect(result.skipped).toBe(1);
		}
	});

	it("skips when Paddle's period differs from the mirror (a renewal not mirrored yet)", async () => {
		const h = harness({ sub: paddleSub({ current_billing_period: { starts_at: END, ends_at: new Date(END.getTime() + 1) } }) });
		await runPaddleOverageSweep(NOW, h.deps);
		expect(h.posts).toHaveLength(0);
		expect(h.store.rows).toHaveLength(0);
	});

	it("records a currency it has no rate for as failed and pages, posting nothing", async () => {
		const h = harness({ sub: paddleSub({ currency_code: "GBP" }) });
		await runPaddleOverageSweep(NOW, h.deps);
		expect(h.posts).toHaveLength(0);
		expect(h.store.rows[0]).toMatchObject({ status: "failed", currency: "gbp" });
		expect(h.alerts).toEqual(["Paddle overage not priced"]);
	});

	it("skips a paused or trialing subscription", async () => {
		for (const status of ["paused", "trialing"] as const) {
			const h = harness({ sub: paddleSub({ status }) });
			await runPaddleOverageSweep(NOW, h.deps);
			expect(h.posts).toHaveLength(0);
		}
	});

	it("waits on a past-due subscription, then pages in the last hour", async () => {
		const h = harness({ sub: paddleSub({ status: "past_due" }), candidate: { status: "past_due" } });
		await runPaddleOverageSweep(NOW, h.deps);
		expect(h.store.rows).toHaveLength(0);
		await runPaddleOverageSweep(new Date(END.getTime() - 30 * 60 * 1000), h.deps);
		expect(h.posts).toHaveLength(0);
		expect(h.store.rows[0].status).toBe("failed");
		expect(h.alerts).toEqual(["Paddle overage not charged (past due)"]);
	});
});

describe("final cancellation (O9)", () => {
	const cancel = { action: "cancel", effective_at: END };

	it("charges immediately when the overage is at least €5", async () => {
		const h = harness({ used: 1000, sub: paddleSub({ scheduled_change: cancel }) }); // 500 over → €5.50
		await runPaddleOverageSweep(NOW, h.deps);
		expect(h.posts).toHaveLength(1);
		expect(h.posts[0]).toMatchObject({ immediate: true, amount: { minor: 550 } });
		expect(h.store.rows[0]).toMatchObject({ status: "reconciled", providerRef: "txn_now" });
	});

	it("charges immediately at exactly €5", async () => {
		const h = harness({ used: 500 + 455, sub: paddleSub({ scheduled_change: cancel }) }); // 455 min → 500 minor
		await runPaddleOverageSweep(NOW, h.deps);
		expect(h.posts[0]).toMatchObject({ immediate: true, amount: { minor: 500 } });
	});

	it("waives below €5 and posts nothing", async () => {
		const h = harness({ used: 750, sub: paddleSub({ scheduled_change: cancel }) }); // €2.75
		const result = await runPaddleOverageSweep(NOW, h.deps);
		expect(h.posts).toHaveLength(0);
		expect(h.store.rows[0]).toMatchObject({ status: "waived", amountMinor: 275 });
		expect(h.store.rows[0].error).toMatch(/O9/);
		expect(result.waived).toBe(1);
	});
});

describe("failures and reconciliation", () => {
	it("a refused charge fails the row and pages the operator", async () => {
		const h = harness();
		h.post.mockRejectedValueOnce(new PaddleApiError("http", "Paddle POST → 400 bad_request", { status: 400, code: "bad_request" }));
		const result = await runPaddleOverageSweep(NOW, h.deps);
		expect(h.store.rows[0]).toMatchObject({ status: "failed", error: "Paddle POST → 400 bad_request" });
		expect(h.alerts).toEqual(["Paddle refused an overage charge"]);
		expect(result.failed).toBe(1);
	});

	it("an unknown outcome stays claimed; the retry finds the charge and does NOT post again", async () => {
		const h = harness();
		// Paddle created the charge but the reply was lost.
		h.post.mockImplementationOnce(async (c: UsageChargeRequest) => {
			h.held.set(c.usageChargeId, { providerRef: "pri_next" });
			throw new PaddleApiError("timeout", "timed out");
		});
		const first = await runPaddleOverageSweep(NOW, h.deps);
		expect(first.pending).toBe(1);
		expect(h.store.rows[0].status).toBe("claimed");

		// Before the claim is stale, nothing happens.
		await runPaddleOverageSweep(new Date(NOW.getTime() + 60_000), h.deps);
		expect(h.post).toHaveBeenCalledTimes(1);

		const retry = await runPaddleOverageSweep(new Date(NOW.getTime() + STALE_CLAIM_MS + 1), h.deps);
		expect(h.post).toHaveBeenCalledTimes(1);
		expect(h.store.rows[0]).toMatchObject({ status: "reconciled", providerRef: "pri_next" });
		expect(retry.reconciled).toBe(1);
	});

	it("an unknown outcome whose charge never landed is posted again after the lookup", async () => {
		const h = harness();
		h.post.mockRejectedValueOnce(new PaddleApiError("http", "Paddle → 503", { status: 503 }));
		await runPaddleOverageSweep(NOW, h.deps);
		expect(h.store.rows[0].status).toBe("claimed");
		await runPaddleOverageSweep(new Date(NOW.getTime() + STALE_CLAIM_MS + 1), h.deps);
		expect(h.find.mock.invocationCallOrder[0]).toBeLessThan(h.post.mock.invocationCallOrder[1]);
		expect(h.post).toHaveBeenCalledTimes(2);
		expect(h.post.mock.calls[1][0].usageChargeId).toBe(h.post.mock.calls[0][0].usageChargeId);
		expect(h.store.rows[0].status).toBe("reconciled");
	});

	it("a lookup that fails re-posts nothing, and the pass reports the failure", async () => {
		const h = harness();
		h.post.mockRejectedValueOnce(new PaddleApiError("network", "reset"));
		await runPaddleOverageSweep(NOW, h.deps);
		h.find.mockRejectedValueOnce(new PaddleApiError("timeout", "slow"));
		await expect(runPaddleOverageSweep(new Date(NOW.getTime() + STALE_CLAIM_MS + 1), h.deps)).rejects.toThrow(/1 failed/);
		expect(h.post).toHaveBeenCalledTimes(1);
		expect(h.store.rows[0].status).toBe("claimed");
	});

	it("two instances reconciling one stale claim: only one re-claims it", async () => {
		const h = harness();
		h.post.mockRejectedValueOnce(new PaddleApiError("network", "reset"));
		await runPaddleOverageSweep(NOW, h.deps);
		const later = new Date(NOW.getTime() + STALE_CLAIM_MS + 1);
		await Promise.all([runPaddleOverageSweep(later, h.deps), runPaddleOverageSweep(later, h.deps)]);
		expect(h.post).toHaveBeenCalledTimes(2); // the original attempt + exactly one re-post
	});

	it("gives up after 24h unconfirmed: failed, operator paged, nothing posted", async () => {
		const h = harness();
		h.post.mockRejectedValueOnce(new PaddleApiError("network", "reset"));
		await runPaddleOverageSweep(NOW, h.deps);
		await runPaddleOverageSweep(new Date(NOW.getTime() + UNCONFIRMED_GIVE_UP_MS + 1), h.deps);
		expect(h.post).toHaveBeenCalledTimes(1);
		expect(h.store.rows[0].status).toBe("failed");
		expect(h.alerts).toEqual(["Paddle overage charge unconfirmed"]);
	});

	it("a stale claim on a subscription that is no longer active fails and pages", async () => {
		const h = harness();
		h.post.mockRejectedValueOnce(new PaddleApiError("network", "reset"));
		await runPaddleOverageSweep(NOW, h.deps);
		h.getSubscription.mockResolvedValue(paddleSub({ status: "canceled" }));
		await runPaddleOverageSweep(new Date(NOW.getTime() + STALE_CLAIM_MS + 1), h.deps);
		expect(h.post).toHaveBeenCalledTimes(1);
		expect(h.store.rows[0].status).toBe("failed");
		expect(h.alerts).toEqual(["Paddle overage charge not posted"]);
	});

	it("one subscription failing does not stop the others", async () => {
		const h = harness();
		h.store.cands.unshift({ ...h.store.cands[0], subscriptionId: "sub_broken", organizationId: "org-2" });
		h.getSubscription.mockImplementation(async (id: string) => {
			if (id === "sub_broken") throw new PaddleApiError("http", "Paddle → 500", { status: 500 });
			return paddleSub();
		});
		await expect(runPaddleOverageSweep(NOW, h.deps)).rejects.toThrow(/sub_broken/);
		expect(h.posts.map((p) => p.subscriptionId)).toEqual(["sub_1"]);
	});
});
