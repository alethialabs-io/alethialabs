// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the per-payer purchase lock (#5489) against real Postgres. The action tests run the
// purchase flow over an in-memory mutex with the same contract, so they would stay green if this module
// stopped locking at all. These pin the contract itself:
//
//   1. Two calls with the SAME key run one after the other: the second's work starts only after the
//      first's has finished.
//   2. Calls with DIFFERENT keys do not wait for each other.
//   3. What the work throws is thrown, and the lock is released with it.

import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { withPurchaseLock } from "@/lib/billing/purchase-lock";
import { describeIfDb } from "./db";

/** A promise and the function that resolves it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Resolves once `check` is true, polling every 10ms for up to `ms`. */
async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
	const until = Date.now() + ms;
	while (!check()) {
		if (Date.now() > until) throw new Error("timed out waiting for the condition");
		await new Promise((r) => setTimeout(r, 10));
	}
}

describeIfDb("withPurchaseLock — one purchase per key at a time", () => {
	it("a second call with the same key starts its work only after the first has finished", async () => {
		const key = `it-${randomUUID()}`;
		const events: string[] = [];
		const releaseFirst = deferred();

		const first = withPurchaseLock(key, async () => {
			events.push("first:start");
			await releaseFirst.promise;
			events.push("first:end");
			return 1;
		});
		await waitFor(() => events.includes("first:start"));
		const second = withPurchaseLock(key, async () => {
			events.push("second:start");
			return 2;
		});
		// Give the second call ample time to start if it were not waiting.
		await new Promise((r) => setTimeout(r, 300));
		expect(events).toEqual(["first:start"]);

		releaseFirst.resolve();
		await expect(first).resolves.toEqual({ acquired: true, value: 1 });
		await expect(second).resolves.toEqual({ acquired: true, value: 2 });
		expect(events).toEqual(["first:start", "first:end", "second:start"]);
	});

	it("calls with different keys do not wait for each other", async () => {
		const releaseFirst = deferred();
		let firstStarted = false;
		const first = withPurchaseLock(`it-${randomUUID()}`, async () => {
			firstStarted = true;
			await releaseFirst.promise;
		});
		await waitFor(() => firstStarted);

		await expect(withPurchaseLock(`it-${randomUUID()}`, async () => "other")).resolves.toEqual({
			acquired: true,
			value: "other",
		});
		releaseFirst.resolve();
		await first;
	});

	it("an error from the work is thrown, and the lock is released with it", async () => {
		const key = `it-${randomUUID()}`;
		await expect(
			withPurchaseLock(key, async () => {
				throw new Error("work failed");
			}),
		).rejects.toThrow(/work failed/);
		await expect(withPurchaseLock(key, async () => "after")).resolves.toEqual({
			acquired: true,
			value: "after",
		});
	});
});
