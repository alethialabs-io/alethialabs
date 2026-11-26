// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The `paddle_transaction` mirror backfill (lib/billing/events/backfill.ts, #7672): what it asks
// Paddle for and how it pages, that every transaction goes through the apply step as a mirror-only
// event, and that one transaction the rules refuse, defer or cannot read never stops the run — while
// a failure that is not a rule's (the database) does. The rules themselves are
// apply-billing-event.test.ts's.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApplyResult } from "@/lib/billing/events/apply";
import { RetryableBillingEventError } from "@/lib/billing/events/apply";
import {
	BACKFILL_PAGE_SIZE,
	backfillPaddleTransactions,
	paddleTransactionBackfillEnabled,
} from "@/lib/billing/events/backfill";
import type { PaddleClient, PaddleRequest } from "@/lib/billing/paddle/api";
import type { NormalizedBillingEvent } from "@/lib/billing/provider/types";
import { transactionData } from "../../fixtures/paddle-events";

/** A listed transaction with id `txn_<n>`. */
function listed(n: number, over: Parameters<typeof transactionData>[0] = {}) {
	return transactionData({ id: `txn_${n}`, status: "billed", updated_at: "2026-11-20T08:00:00.000Z", ...over });
}

/** A client that serves `pages` in order and records each request. */
function pagedClient(pages: unknown[][]) {
	const requests: PaddleRequest[] = [];
	let i = 0;
	const client: PaddleClient = {
		environment: "sandbox",
		async request<T extends z.ZodType>(req: PaddleRequest, schema: T): Promise<z.infer<T>> {
			requests.push(req);
			return schema.parse(pages[i++] ?? []);
		},
		getEventTypes: async () => [],
	};
	return { client, requests };
}

/** A full page of `BACKFILL_PAGE_SIZE` transactions numbered from `start`. */
function fullPage(start: number) {
	return Array.from({ length: BACKFILL_PAGE_SIZE }, (_, k) => listed(start + k));
}

describe("backfillPaddleTransactions", () => {
	it("asks for every status the mirror lists or follows, oldest first, and pages by the last id", async () => {
		const { client, requests } = pagedClient([fullPage(0), [listed(100)]]);
		const apply = vi.fn(async (): Promise<ApplyResult> => ({ outcome: "applied" }));
		const report = await backfillPaddleTransactions({ client, apply });
		expect(requests).toHaveLength(2);
		expect(requests[0]).toMatchObject({
			method: "GET",
			path: "/transactions",
			query: { status: "billed,paid,past_due,completed", order_by: "id[ASC]", per_page: BACKFILL_PAGE_SIZE, after: undefined },
		});
		expect(requests[1]?.query?.after).toBe(`txn_${BACKFILL_PAGE_SIZE - 1}`);
		expect(report).toMatchObject({ pages: 2, truncated: false });
		expect(report.counts.applied).toBe(BACKFILL_PAGE_SIZE + 1);
	});

	it("hands each transaction to the apply step as a mirror-only event, never a completion", async () => {
		const { client } = pagedClient([[listed(1, { status: "completed" })]]);
		const seen: NormalizedBillingEvent[] = [];
		await backfillPaddleTransactions({
			client,
			apply: async (event) => {
				seen.push(event);
				return { outcome: "applied" };
			},
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ kind: "transaction_updated", transactionId: "txn_1", transaction: { status: "completed" } });
	});

	it("reports refusals, deferrals and unreadable transactions without stopping", async () => {
		const { client } = pagedClient([[listed(1), listed(2), { id: "txn_3", status: "billed" }, listed(4)]]);
		const apply = vi.fn(async (event: NormalizedBillingEvent): Promise<ApplyResult> => {
			if (event.kind !== "transaction_updated") throw new Error("kind");
			if (event.transactionId === "txn_1") return { outcome: "refused", reason: "unrecorded_org" };
			if (event.transactionId === "txn_2") throw new RetryableBillingEventError("not yet");
			return { outcome: "applied" };
		});
		const report = await backfillPaddleTransactions({ client, apply });
		expect(report.counts).toEqual({ applied: 1, ignored: 0, refused: 1, deferred: 1, unreadable: 1 });
		expect(report.lines.map((l) => [l.transactionId, l.outcome])).toEqual([
			["txn_1", "refused"],
			["txn_2", "deferred"],
			["txn_3", "unreadable"],
			["txn_4", "applied"],
		]);
	});

	it("stops on a failure that is not a rule's", async () => {
		const { client } = pagedClient([[listed(1)]]);
		await expect(
			backfillPaddleTransactions({
				client,
				apply: async () => {
					throw new Error("db down");
				},
			}),
		).rejects.toThrow("db down");
	});

	it("stops at maxPages and says so", async () => {
		const { client, requests } = pagedClient([fullPage(0), fullPage(100), fullPage(200)]);
		const report = await backfillPaddleTransactions({ client, apply: async () => ({ outcome: "applied" }) }, { maxPages: 2 });
		expect(requests).toHaveLength(2);
		expect(report).toMatchObject({ pages: 2, truncated: true });
	});
});

describe("paddleTransactionBackfillEnabled", () => {
	it("is off unless the flag says 1 or true", () => {
		expect(paddleTransactionBackfillEnabled({})).toBe(false);
		expect(paddleTransactionBackfillEnabled({ ALETHIA_PADDLE_TRANSACTION_BACKFILL: "0" })).toBe(false);
		// On, but Paddle is not configured here: still off.
		expect(paddleTransactionBackfillEnabled({ ALETHIA_PADDLE_TRANSACTION_BACKFILL: "1" })).toBe(false);
	});
});
