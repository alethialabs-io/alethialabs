// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// recordAiUsage on a caller's transaction (ADR 0003 §5.3, slice 3). With `tx`, the ledger write
// runs on THAT transaction (never the pooled service connection), and its side effects
// (captureAiGeneration, checkAiSpendThreshold) are NOT run: they come back as the after-commit
// function, so a rolled-back settle reports nothing and the spend alert reads the settled ledger.
// Without `tx`, nothing changes: the pooled write, then both effects, then a no-op return.
//
// The settle-credit derivation itself is pinned by ai-quota-settle.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const pooledInsert = vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) }));
const pooledWhere = vi.fn().mockResolvedValue(undefined);
const pooledSet = vi.fn(() => ({ where: pooledWhere }));
const pooledUpdate = vi.fn(() => ({ set: pooledSet }));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({ insert: pooledInsert, update: pooledUpdate }),
}));
vi.mock("@/lib/db/schema", () => ({ aiUsageLedger: {}, aiCreditGrant: {} }));
vi.mock("@/lib/billing/model-costs", () => ({ aiCostMicros: vi.fn() }));
vi.mock("@/lib/analytics/server", () => ({ captureAiGeneration: vi.fn() }));
vi.mock("@/lib/billing/ai-spend-alert", () => ({
	checkAiSpendThreshold: vi.fn(() => Promise.resolve()),
}));

import { captureAiGeneration } from "@/lib/analytics/server";
import { recordAiUsage } from "@/lib/billing/ai-quota";
import { checkAiSpendThreshold } from "@/lib/billing/ai-spend-alert";
import { aiCostMicros } from "@/lib/billing/model-costs";
import type { Tx } from "@/lib/db";

const MODEL = "anthropic/claude-haiku-4-5";

/** A stand-in transaction that records the writes made on it. */
function fakeTx() {
	const values = vi.fn().mockResolvedValue(undefined);
	const insert = vi.fn(() => ({ values }));
	const where = vi.fn().mockResolvedValue(undefined);
	const set = vi.fn(() => ({ where }));
	const update = vi.fn(() => ({ set }));
	return { insert, update, values, set };
}

/**
 * Run recordAiUsage on the fake transaction — the one place the fake meets the real signature
 * (the test-only assertion: the fake implements just the two builders recordAiUsage calls).
 */
async function recordOnTx(
	tx: ReturnType<typeof fakeTx>,
	input: Parameters<typeof recordAiUsage>[0],
) {
	return recordAiUsage(input, tx as unknown as Tx);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(aiCostMicros).mockReturnValue(42_000); // 42 credits
});

describe("recordAiUsage with a caller's tx", () => {
	it("writes the appended row on the tx, never on the pooled connection", async () => {
		const tx = fakeTx();
		await recordOnTx(tx, {
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			source: "included",
			model: MODEL,
		});
		expect(tx.insert).toHaveBeenCalledTimes(1);
		expect(tx.values).toHaveBeenCalledWith(
			expect.objectContaining({ credits: 42, org_id: "org-1" }),
		);
		expect(pooledInsert).not.toHaveBeenCalled();
	});

	it("reconciles the hold row on the tx, never on the pooled connection", async () => {
		const tx = fakeTx();
		await recordOnTx(tx, {
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			source: "included",
			holdId: "hold-1",
			model: MODEL,
		});
		expect(tx.update).toHaveBeenCalledTimes(1);
		expect(tx.set).toHaveBeenCalledWith(
			expect.objectContaining({ credits: 42, settled_at: expect.any(Date) }),
		);
		expect(pooledUpdate).not.toHaveBeenCalled();
	});

	it("runs NO side effect before the caller's commit, and both once the after-commit runs", async () => {
		const tx = fakeTx();
		const afterCommit = await recordOnTx(tx, {
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			source: "included",
			holdId: "hold-1",
			model: MODEL,
		});
		// Inside the caller's transaction: the row is written, nothing else has happened.
		expect(captureAiGeneration).not.toHaveBeenCalled();
		expect(checkAiSpendThreshold).not.toHaveBeenCalled();

		afterCommit();
		expect(captureAiGeneration).toHaveBeenCalledTimes(1);
		expect(captureAiGeneration).toHaveBeenCalledWith(
			expect.objectContaining({ orgId: "org-1", model: MODEL, costMicros: 42_000 }),
		);
		expect(checkAiSpendThreshold).toHaveBeenCalledTimes(1);
		expect(checkAiSpendThreshold).toHaveBeenCalledWith("org-1");
	});

	it("a rolled-back caller that never runs the after-commit reports nothing", async () => {
		const tx = fakeTx();
		await recordOnTx(tx, {
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			source: "included",
			model: MODEL,
		});
		expect(captureAiGeneration).not.toHaveBeenCalled();
		expect(checkAiSpendThreshold).not.toHaveBeenCalled();
	});
});

describe("recordAiUsage without a tx (every existing caller)", () => {
	it("writes on the pooled connection and runs both side effects at once", async () => {
		const afterCommit = await recordAiUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			source: "included",
			model: MODEL,
		});
		expect(pooledInsert).toHaveBeenCalledTimes(1);
		expect(captureAiGeneration).toHaveBeenCalledTimes(1);
		expect(checkAiSpendThreshold).toHaveBeenCalledTimes(1);

		// The returned function does nothing: the effects are not run a second time.
		afterCommit();
		expect(captureAiGeneration).toHaveBeenCalledTimes(1);
		expect(checkAiSpendThreshold).toHaveBeenCalledTimes(1);
	});
});
