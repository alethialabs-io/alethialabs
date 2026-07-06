// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Delivery dispatch + retry (dataroom/spec/mvp/25-alerting-notifications.md). A delivery row
// is the unit of work: deliverOne() CLAIMS the row (so the inline dispatch and the
// sweep never double-send across instances), loads its channel, sends, and advances the
// ledger (sent | failed+backoff | dead). startAlertScheduler() runs sweepDueDeliveries()
// in-process (lib/alerts/scheduler.ts). Best-effort: a send failure never throws out.

import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { alertChannels, alertDeliveries } from "@/lib/db/schema";
import type { AlertDelivery } from "@/lib/db/schema";
import { getChannelSender } from "./channels";

/** Exponential backoff (capped) for attempt N: 1m, 2m, 4m, 8m, 16m, … ≤ 1h. */
function backoffMs(attempt: number): number {
	return Math.min(60_000 * 2 ** attempt, 60 * 60_000);
}

// How long a claimed delivery stays invisible to other workers while being sent. If the
// process dies mid-send, the row reappears after this and is retried.
const VISIBILITY_MS = 120_000;

/**
 * Sends one delivery and advances its ledger row. First atomically CLAIMS the row by
 * pushing next_attempt_at forward — only one worker wins (Postgres row lock), so the
 * inline dispatch and the sweep can't double-send. A claimed row whose channel is
 * gone/disabled is marked dead; otherwise send → sent, or failed with backoff, or dead
 * once attempts hit max_attempts.
 */
export async function deliverOne(delivery: AlertDelivery): Promise<void> {
	const db = getServiceDb();

	// Claim: re-read by id, only if still pending/failed AND due (null or past schedule).
	const [claimed] = await db
		.update(alertDeliveries)
		.set({ next_attempt_at: new Date(Date.now() + VISIBILITY_MS) })
		.where(
			and(
				eq(alertDeliveries.id, delivery.id),
				inArray(alertDeliveries.status, ["pending", "failed"]),
				or(
					isNull(alertDeliveries.next_attempt_at),
					lte(alertDeliveries.next_attempt_at, sql`now()`),
				),
			),
		)
		.returning();
	if (!claimed) return; // another worker owns it, or it's already sent/dead

	const attempt = claimed.attempts + 1;

	if (!claimed.channel_id) {
		await db
			.update(alertDeliveries)
			.set({ status: "dead", last_error: "channel removed", attempts: attempt })
			.where(eq(alertDeliveries.id, claimed.id));
		return;
	}

	const [channel] = await db
		.select()
		.from(alertChannels)
		.where(eq(alertChannels.id, claimed.channel_id))
		.limit(1);

	if (!channel || !channel.enabled) {
		await db
			.update(alertDeliveries)
			.set({
				status: "dead",
				last_error: channel ? "channel disabled" : "channel removed",
				attempts: attempt,
			})
			.where(eq(alertDeliveries.id, claimed.id));
		return;
	}

	try {
		await getChannelSender(channel.type).send(channel, claimed.context);
		await db
			.update(alertDeliveries)
			.set({
				status: "sent",
				attempts: attempt,
				sent_at: new Date(),
				last_error: null,
				next_attempt_at: null,
			})
			.where(eq(alertDeliveries.id, claimed.id));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const dead = attempt >= claimed.max_attempts;
		await db
			.update(alertDeliveries)
			.set({
				status: dead ? "dead" : "failed",
				attempts: attempt,
				last_error: message,
				next_attempt_at: dead ? null : new Date(Date.now() + backoffMs(attempt)),
			})
			.where(eq(alertDeliveries.id, claimed.id));
	}
}

/**
 * Dispatches a batch of freshly-queued deliveries concurrently (best-effort; emit.ts
 * calls this fire-and-forget right after inserting `pending` rows for low latency).
 */
export async function dispatchDeliveries(
	deliveries: AlertDelivery[],
): Promise<void> {
	await Promise.allSettled(deliveries.map(deliverOne));
}

/**
 * Retry sweep: claims deliveries that are due (pending with no schedule, or failed
 * with next_attempt_at in the past) and re-sends them. Invoked on a minute cron via an
 * internal route. Returns the number processed.
 */
export async function sweepDueDeliveries(limit = 100): Promise<number> {
	const db = getServiceDb();
	const due = await db
		.select()
		.from(alertDeliveries)
		.where(
			or(
				and(eq(alertDeliveries.status, "pending"), isNull(alertDeliveries.next_attempt_at)),
				and(
					inArray(alertDeliveries.status, ["pending", "failed"]),
					lte(alertDeliveries.next_attempt_at, sql`now()`),
				),
			),
		)
		.limit(limit);

	await Promise.allSettled(due.map(deliverOne));
	return due.length;
}
