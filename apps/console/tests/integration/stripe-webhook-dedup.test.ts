// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): the Stripe webhook exactly-once fix (audit finding #17). Stripe can
// re-deliver an event while the first delivery's handler is still IN-FLIGHT (network dup / retry);
// the old guard only skipped an already-`done` row, so a still-`processing` re-delivery fell through
// and re-ran handleStripeEvent → the branded email was sent TWICE. runWebhookEventExactlyOnce now
// serializes deliveries of the same event id under a per-event advisory lock and runs the handler
// inside it, so a concurrent/retried delivery blocks until the first commits `done` and is skipped.
// Proven end-to-end against a real database:
//  1. Two SAME-id deliveries fired CONCURRENTLY (Promise.all), handler stub counts its runs → runs
//     EXACTLY ONCE; the loser is skipped; the row ends `done`.
//  2. A re-delivery AFTER completion → skipped, handler NOT re-run.
//  3. A stale `processing` row (createdAt backdated beyond the lease) → treated as a crashed prior
//     attempt and RE-RUN (crash recovery).
//  4. A fresh `processing` row we did NOT claim, still within the lease → skipped as in-flight
//     (the belt-and-suspenders lease insurance) — handler NOT run.
//
// Needs `pnpm db:up` (or any migrated Postgres on ALETHIA_DATABASE_URL); skips when unreachable.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import {
	type ClaimResult,
	claimWebhookEvent,
	runWebhookEventExactlyOnce,
	WEBHOOK_PROCESSING_LEASE_MS,
	type WebhookRunOutcome,
} from "@/lib/billing/webhook-events";
import { getServiceDb } from "@/lib/db";
import { stripeWebhookEvent } from "@/lib/db/schema";
import { describeIfDb } from "./db";

// Event ids touched by the suite — cleaned up at the end.
const touchedIds: string[] = [];

/** A fresh, isolated Stripe-style event id (tracked for teardown). */
function freshEventId(): string {
	const id = `evt_test_${randomUUID().replace(/-/g, "")}`;
	touchedIds.push(id);
	return id;
}

/** Reads the stored row for an event id (status + createdAt), or undefined. */
async function readRow(eventId: string) {
	const [row] = await getServiceDb()
		.select({
			status: stripeWebhookEvent.status,
			createdAt: stripeWebhookEvent.createdAt,
		})
		.from(stripeWebhookEvent)
		.where(eq(stripeWebhookEvent.eventId, eventId))
		.limit(1);
	return row;
}

/**
 * Mirrors the route's exactly-once path for a single delivery: claim, fast-skip an already-`done`
 * row, else run the serialized handler. Returns the effective outcome ("skipped_done" for the
 * fast-path duplicate).
 */
async function deliver(
	eventId: string,
	type: string,
	handler: () => Promise<void>,
): Promise<WebhookRunOutcome> {
	const claim: ClaimResult = await claimWebhookEvent(eventId, type);
	if (!claim.claimed && claim.alreadyDone) return "skipped_done";
	return runWebhookEventExactlyOnce(eventId, type, claim, handler);
}

/** A handler stub that counts its invocations after a small delay (to overlap concurrent deliveries). */
function countingHandler(delayMs = 60): { runs: () => number; fn: () => Promise<void> } {
	let runs = 0;
	return {
		runs: () => runs,
		fn: async () => {
			await new Promise((r) => setTimeout(r, delayMs));
			runs += 1;
		},
	};
}

describeIfDb("stripe webhook exactly-once (advisory-lock dedup)", () => {
	afterAll(async () => {
		const db = getServiceDb();
		for (const id of touchedIds) {
			await db
				.delete(stripeWebhookEvent)
				.where(eq(stripeWebhookEvent.eventId, id));
		}
	});

	it("runs the handler EXACTLY ONCE for two concurrent deliveries of the same event id", async () => {
		const eventId = freshEventId();
		const handler = countingHandler(80);

		// Fire the SAME id twice concurrently — the in-flight-duplicate the audit reported.
		const [a, b] = await Promise.all([
			deliver(eventId, "invoice.payment_succeeded", handler.fn),
			deliver(eventId, "invoice.payment_succeeded", handler.fn),
		]);

		// The email-sending handler ran once and only once.
		expect(handler.runs()).toBe(1);
		// Exactly one delivery handled it; the other was skipped (done or deferred in-flight).
		const outcomes = [a, b].sort();
		expect(outcomes).toContain("handled");
		expect(outcomes.filter((o) => o === "handled").length).toBe(1);
		// The row is settled `done`.
		expect((await readRow(eventId))?.status).toBe("done");
	});

	it("skips a re-delivery AFTER completion — the handler is not re-run", async () => {
		const eventId = freshEventId();
		const first = countingHandler(0);
		const firstOutcome = await deliver(eventId, "customer.subscription.deleted", first.fn);
		expect(firstOutcome).toBe("handled");
		expect(first.runs()).toBe(1);

		// A later re-delivery of the same id: the fast-path sees `done` and never touches the handler.
		const second = countingHandler(0);
		const secondOutcome = await deliver(eventId, "customer.subscription.deleted", second.fn);
		expect(secondOutcome).toBe("skipped_done");
		expect(second.runs()).toBe(0);
		expect((await readRow(eventId))?.status).toBe("done");
	});

	it("RE-RUNS a stale `processing` row (crashed prior attempt) beyond the lease", async () => {
		const eventId = freshEventId();
		// Simulate a prior attempt that claimed the row then CRASHED: a lingering `processing` row
		// whose createdAt is backdated well beyond the lease.
		await getServiceDb()
			.insert(stripeWebhookEvent)
			.values({
				eventId,
				type: "invoice.payment_succeeded",
				status: "processing",
				createdAt: new Date(Date.now() - WEBHOOK_PROCESSING_LEASE_MS - 60_000),
			});

		const handler = countingHandler(0);
		const outcome = await deliver(eventId, "invoice.payment_succeeded", handler.fn);

		// Stale ⇒ crash recovery: the handler re-runs and the row is driven to `done`.
		expect(outcome).toBe("handled");
		expect(handler.runs()).toBe(1);
		expect((await readRow(eventId))?.status).toBe("done");
	});

	it("SKIPS a fresh unclaimed `processing` row within the lease (in-flight insurance)", async () => {
		const eventId = freshEventId();
		// A row claimed just now by some other in-flight delivery — createdAt is fresh (default now()).
		await getServiceDb()
			.insert(stripeWebhookEvent)
			.values({
				eventId,
				type: "invoice.payment_succeeded",
				status: "processing",
			});

		// This delivery did NOT win the claim (row already exists) and it is not already done.
		const claim = await claimWebhookEvent(eventId, "invoice.payment_succeeded");
		expect(claim).toEqual({ claimed: false, alreadyDone: false });

		const handler = countingHandler(0);
		const outcome = await runWebhookEventExactlyOnce(
			eventId,
			"invoice.payment_succeeded",
			claim,
			handler.fn,
		);

		// Fresh ⇒ deferred to the (assumed) live in-flight holder; handler must NOT run.
		expect(outcome).toBe("skipped_inflight");
		expect(handler.runs()).toBe(0);
		expect((await readRow(eventId))?.status).toBe("processing");
	});
});
