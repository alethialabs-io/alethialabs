// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the card-less trial's ceilings against real Postgres (lib/billing/trial/store.ts,
// REL-L19 #6907). The unit test pins the statement order over a fake; this proves what the SQL means:
// a lifetime counter never empties and survives the bucket sweep, a trailing counter forgets a slot
// once its day leaves the window, a full counter spends nothing of the others, a release gives a slot
// back, and concurrent starts against one key admit exactly the limit.

import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { TrialCounter } from "@/lib/billing/trial/ceilings";
import { peekFullCounter, releaseTrialSlots, reserveTrialSlots } from "@/lib/billing/trial/store";
import { getServiceDb } from "@/lib/db";
import { rateLimitBuckets } from "@/lib/db/schema";
import { sweepExpiredRateLimitBuckets } from "@/lib/rate-limit";
import { describeIfDb } from "./db";

const RUN = `trial:it-${randomUUID().slice(0, 8)}`;

/** A counter under this run's prefix. */
function counter(name: string, limit: number, windowDays: number | null): TrialCounter {
	return { key: `${RUN}:${name}`, limit, windowDays, refusal: "trial_network_limit" };
}

/** The hits recorded for `key`, summed over its rows. */
async function hitsOf(key: string): Promise<number> {
	const [row] = await getServiceDb()
		.select({ hits: sql<number>`coalesce(sum(${rateLimitBuckets.hits}), 0)::integer` })
		.from(rateLimitBuckets)
		.where(sql`${rateLimitBuckets.key} = ${key}`);
	return Number(row?.hits ?? 0);
}

describeIfDb("trial ceilings — the bucket-table store", () => {
	afterAll(async () => {
		await getServiceDb().delete(rateLimitBuckets).where(like(rateLimitBuckets.key, `${RUN}:%`));
	});

	it("a lifetime counter admits its limit, refuses the next, and survives the bucket sweep", async () => {
		const org = counter("org", 1, null);
		expect((await reserveTrialSlots([org])).ok).toBe(true);
		const second = await reserveTrialSlots([org]);
		expect(second).toEqual({ ok: false, refused: org });
		await sweepExpiredRateLimitBuckets(getServiceDb());
		expect(await hitsOf(org.key)).toBe(1);
		expect(await peekFullCounter([org])).toEqual(org);
	});

	it("a full counter spends nothing of the others", async () => {
		const full = counter("full", 1, null);
		const other = counter("other", 5, 30);
		expect((await reserveTrialSlots([full])).ok).toBe(true);
		expect((await reserveTrialSlots([other, full])).ok).toBe(false);
		expect(await hitsOf(other.key)).toBe(0);
	});

	it("a release gives the slot back", async () => {
		const person = counter("person", 1, null);
		const first = await reserveTrialSlots([person]);
		if (!first.ok) throw new Error("fixture: the first reservation was refused");
		await releaseTrialSlots(first.slots);
		expect(await hitsOf(person.key)).toBe(0);
		expect((await reserveTrialSlots([person])).ok).toBe(true);
	});

	it("a trailing counter forgets a slot whose day left the window, and keeps it past one day's sweep", async () => {
		const network = counter("network", 2, 30);
		// A slot from 31 days ago: outside the window, and still in the table until its own expiry.
		await getServiceDb()
			.insert(rateLimitBuckets)
			.values({
				key: network.key,
				window_start: sql`date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' - interval '31 days'`,
				hits: 2,
				expires_at: sql`now() + interval '1 hour'`,
			});
		expect((await reserveTrialSlots([network])).ok).toBe(true);
		expect((await reserveTrialSlots([network])).ok).toBe(true);
		expect((await reserveTrialSlots([network])).ok).toBe(false);
		// Today's row expires 31 days out, so the reconcile loop's sweep does not empty the window.
		await sweepExpiredRateLimitBuckets(getServiceDb());
		expect(await peekFullCounter([network])).toEqual(network);
	});

	it("concurrent starts against one key admit exactly the limit", async () => {
		const shared = counter("race", 3, 30);
		const results = await Promise.all(Array.from({ length: 8 }, () => reserveTrialSlots([shared])));
		expect(results.filter((r) => r.ok)).toHaveLength(3);
		expect(await hitsOf(shared.key)).toBe(3);
	});
});
