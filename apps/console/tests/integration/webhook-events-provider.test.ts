// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): the webhook ledger is keyed on (provider, event_id) — Paddle Billing L1.
// Stripe and Paddle both name events `evt_…`, so the SAME id string can arrive from both. Before the
// provider column, the second provider's claim would have collided with the first's row and been
// skipped as a duplicate — a real Paddle event dropped because Stripe once sent an event with the same
// id. Proven here against the real table and the real advisory lock:
//  1. The same id claimed under two providers is two claims; finishing one leaves the other open.
//  2. Both run their handler (neither is skipped as the other's duplicate), and a re-delivery to
//     either provider is then skipped.
//  3. Resetting one provider's row leaves the other's untouched.
//  4. The two lock keys differ, so the deliveries never serialize against each other.
//
// Needs `pnpm db:up` (or any migrated Postgres on ALETHIA_DATABASE_URL); skips when unreachable.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import {
	claimWebhookEvent,
	markWebhookEventDone,
	resetWebhookEvent,
	runWebhookEventExactlyOnce,
	webhookEventLockKey,
} from "@/lib/billing/webhook-events";
import { getServiceDb } from "@/lib/db";
import { stripeWebhookEvent } from "@/lib/db/schema";
import type { BillingProviderId } from "@/lib/db/schema/billing-provider";
import { describeIfDb } from "./db";

const touchedIds: string[] = [];

/** A fresh event id, shared by both providers in a case (tracked for teardown). */
function freshEventId(): string {
	const id = `evt_test_${randomUUID().replace(/-/g, "")}`;
	touchedIds.push(id);
	return id;
}

/** The stored status for one provider's event id, or undefined. */
async function statusOf(provider: BillingProviderId, eventId: string) {
	const [row] = await getServiceDb()
		.select({ status: stripeWebhookEvent.status })
		.from(stripeWebhookEvent)
		.where(and(eq(stripeWebhookEvent.provider, provider), eq(stripeWebhookEvent.eventId, eventId)))
		.limit(1);
	return row?.status;
}

describeIfDb("webhook ledger is per provider", () => {
	afterAll(async () => {
		const db = getServiceDb();
		for (const id of touchedIds) {
			await db.delete(stripeWebhookEvent).where(eq(stripeWebhookEvent.eventId, id));
		}
	});

	it("claims the same event id independently under each provider", async () => {
		const id = freshEventId();
		expect(await claimWebhookEvent("stripe", id, "invoice.paid")).toEqual({ claimed: true });
		expect(await claimWebhookEvent("paddle", id, "transaction.completed")).toEqual({ claimed: true });

		await markWebhookEventDone("stripe", id);
		expect(await statusOf("stripe", id)).toBe("done");
		expect(await statusOf("paddle", id)).toBe("processing");

		// A re-delivery is a duplicate only under its OWN provider.
		expect(await claimWebhookEvent("stripe", id, "invoice.paid")).toEqual({ claimed: false, alreadyDone: true });
		expect(await claimWebhookEvent("paddle", id, "transaction.completed")).toEqual({
			claimed: false,
			alreadyDone: false,
		});
	});

	it("runs each provider's handler once, and skips only that provider's re-delivery", async () => {
		const id = freshEventId();
		let stripeRuns = 0;
		let paddleRuns = 0;
		await claimWebhookEvent("stripe", id, "invoice.paid");
		await claimWebhookEvent("paddle", id, "transaction.completed");

		const [s, p] = await Promise.all([
			runWebhookEventExactlyOnce("stripe", id, "invoice.paid", async () => {
				stripeRuns += 1;
			}),
			runWebhookEventExactlyOnce("paddle", id, "transaction.completed", async () => {
				paddleRuns += 1;
			}),
		]);
		expect([s, p]).toEqual(["handled", "handled"]);
		expect([stripeRuns, paddleRuns]).toEqual([1, 1]);

		expect(
			await runWebhookEventExactlyOnce("paddle", id, "transaction.completed", async () => {
				paddleRuns += 1;
			}),
		).toBe("skipped_done");
		expect(paddleRuns).toBe(1);
	});

	it("resets one provider's row without touching the other's", async () => {
		const id = freshEventId();
		await claimWebhookEvent("stripe", id, "invoice.paid");
		await claimWebhookEvent("paddle", id, "transaction.completed");

		expect(await resetWebhookEvent("paddle", id)).toBe(true);
		expect(await statusOf("paddle", id)).toBeUndefined();
		expect(await statusOf("stripe", id)).toBe("processing");
	});

	it("keys the advisory lock on the provider as well as the id", () => {
		expect(webhookEventLockKey("stripe", "evt_1")).not.toBe(webhookEventLockKey("paddle", "evt_1"));
	});
});
