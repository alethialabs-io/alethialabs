// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): the Stripe webhook's exactly-once lock cannot stall the service pool
// (#6027). `runWebhookEventExactlyOnce` holds a transaction with a per-event advisory lock for the
// whole of the handler, and the handler (`handleStripeEvent`) reads and writes through
// `getServiceDb()`. A lock held on a service connection would let `poolMax` deliveries of different
// events take every connection and then wait forever for one more: postgres-js has no acquisition
// timeout (#6012), so nothing would break that wait, and every service query on the instance would
// queue behind them.
//
// The service pool is shrunk to 2 for this file (`vi.hoisted` runs before any module reads the
// config), so "every connection" is two deliveries rather than ten. Proven here:
//   1. A pool's worth of deliveries, each inside its lock, can each query through the service pool,
//      and a service query from outside any delivery still runs meanwhile. Each ends `handled`, `done`.
//   2. A handler that throws under the same load releases its lock and leaves the row un-done (the
//      done-mark rolls back with the lock transaction), so the retry runs the handler again.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";
import { claimWebhookEvent, runWebhookEventExactlyOnce } from "@/lib/billing/webhook-events";
import { getServiceDb } from "@/lib/db";
import { stripeWebhookEvent } from "@/lib/db/schema";
import { describeIfDb } from "./db";

vi.hoisted(() => {
	process.env.ALETHIA_DB_POOL_MAX = "2";
});

/** The pool size this file runs with: the value set above. */
const POOL_MAX = 2;

/** Event ids touched by the suite, deleted at the end. */
const touchedIds: string[] = [];

/** A fresh Stripe-style event id, tracked for teardown. */
function freshEventId(): string {
	const id = `evt_test_${randomUUID().replace(/-/g, "")}`;
	touchedIds.push(id);
	return id;
}

/** A promise and the function that resolves it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Rejects with "stalled" when `p` has not settled within `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("stalled")), ms);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The `max` the postgres-js client under a drizzle handle was built with, read from the client
 * (`$client.options.max`); undefined when the handle has no such client. The `Db` type does not
 * carry `$client`, so it is narrowed here instead of cast.
 */
function builtPoolMax(db: object): unknown {
	if (!("$client" in db)) return undefined;
	const client: unknown = db.$client;
	if ((typeof client !== "object" && typeof client !== "function") || client === null) return undefined;
	if (!("options" in client)) return undefined;
	const options: unknown = client.options;
	if (typeof options !== "object" || options === null || !("max" in options)) return undefined;
	return options.max;
}

/** The stored status of an event id, or undefined when it has no row. */
async function statusOf(eventId: string): Promise<string | undefined> {
	const [row] = await getServiceDb()
		.select({ status: stripeWebhookEvent.status })
		.from(stripeWebhookEvent)
		.where(eq(stripeWebhookEvent.eventId, eventId))
		.limit(1);
	return row?.status;
}

/**
 * Starts `POOL_MAX` deliveries of distinct events, claimed first as the route claims them. Each
 * handler waits until every delivery is inside its lock, then queries through the service pool,
 * then waits for `release`; `fail` makes every handler throw after its query.
 */
async function startDeliveries(fail: boolean): Promise<{
	ids: string[];
	allIn: Promise<void>;
	release: () => void;
	runs: Promise<PromiseSettledResult<string>[]>;
}> {
	const ids = Array.from({ length: POOL_MAX }, () => freshEventId());
	for (const id of ids) {
		expect(await claimWebhookEvent(id, "invoice.payment_succeeded")).toEqual({ claimed: true });
	}
	let entered = 0;
	const allIn = deferred();
	const release = deferred();
	const runs = Promise.allSettled(
		ids.map((id, i) =>
			runWebhookEventExactlyOnce(id, "invoice.payment_succeeded", async () => {
				entered += 1;
				if (entered === POOL_MAX) allIn.resolve();
				// Every delivery is inside its lock before any of them asks the service pool for a
				// connection: the moment a lock that held a service connection would have none left.
				await allIn.promise;
				await getServiceDb().execute(sql`select ${i}::int as n`);
				await release.promise;
				if (fail) throw new Error(`handler ${i} failed`);
			}),
		),
	);
	return { ids, allIn: allIn.promise, release: release.resolve, runs };
}

describeIfDb("stripe webhook exactly-once — the lock does not hold a service connection", () => {
	afterAll(async () => {
		for (const id of touchedIds) {
			await getServiceDb().delete(stripeWebhookEvent).where(eq(stripeWebhookEvent.eventId, id));
		}
	});

	it("as many deliveries as the service pool has connections can each query through it", async () => {
		// The pool actually built, not the config: a service client cached by an earlier file would
		// carry its own size, and the test would then exercise nothing.
		expect(builtPoolMax(getServiceDb())).toBe(POOL_MAX);
		const { ids, allIn, release, runs } = await startDeliveries(false);
		try {
			await within(allIn, 5000);
			// With every delivery holding its lock, a query from outside any delivery still runs.
			await expect(within(getServiceDb().execute(sql`select 1 as one`), 5000)).resolves.toEqual([{ one: 1 }]);
			release();
			const settled = await within(runs, 5000);
			expect(settled).toEqual(ids.map(() => ({ status: "fulfilled", value: "handled" })));
			for (const id of ids) expect(await statusOf(id)).toBe("done");
		} finally {
			release();
		}
	});

	it("a handler that throws under the same load releases its lock and leaves the event to retry", async () => {
		const { ids, allIn, release, runs } = await startDeliveries(true);
		try {
			await within(allIn, 5000);
			release();
			const settled = await within(runs, 5000);
			expect(settled.map((s) => s.status)).toEqual(ids.map(() => "rejected"));
			// The done-mark rolled back with the lock transaction: the claim row is still `processing`.
			for (const id of ids) expect(await statusOf(id)).toBe("processing");
		} finally {
			release();
		}
		// The lock went with the rollback, so the retry takes it at once and runs the handler.
		let reruns = 0;
		for (const id of ids) {
			const outcome = await within(
				runWebhookEventExactlyOnce(id, "invoice.payment_succeeded", async () => {
					reruns += 1;
				}),
				5000,
			);
			expect(outcome).toBe("handled");
			expect(await statusOf(id)).toBe("done");
		}
		expect(reruns).toBe(POOL_MAX);
	});
});
