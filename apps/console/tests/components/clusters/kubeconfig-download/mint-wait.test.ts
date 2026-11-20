// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6819 (lib/realtime/README.md, rule 3): the kubeconfig download waits for the runner on the `jobs`
// topic, not on a timer loop. The wait is a Query entry under the `["jobs"]` prefix — the prefix
// `TOPIC_KEYS.jobs` invalidates — and this is what turns "that entry was invalidated" into the
// promise the flow awaits. Driven over a real QueryClient, so "invalidated" here is what the change
// stream's client does.

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	MAX_TIMER_MS,
	MINT_WAIT_KEY,
	createMintWait,
	mintWaitKey,
} from "@/components/clusters/kubeconfig-download/mint-wait";
import { TOPIC_KEYS } from "@/lib/query/topics";

vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({}).orpc };
});

const CLUSTER = "33333333-3333-4333-8333-333333333333";
const FAR = Date.parse("2099-01-01T00:00:00.000Z");

/** A timer the test fires by hand. */
function manualTimers() {
	const pending: Array<() => void> = [];
	return {
		pending,
		timers: {
			setTimeout: (fn: () => void) => {
				pending.push(fn);
				return setTimeout(() => {}, 0);
			},
			clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
		},
	};
}

/** Whether `promise` has settled by the time the microtask queue has drained. */
async function settled(promise: Promise<void>): Promise<boolean> {
	let done = false;
	void promise.then(() => {
		done = true;
	});
	for (let i = 0; i < 5; i += 1) await Promise.resolve();
	return done;
}

let client: QueryClient;
beforeEach(() => {
	client = new QueryClient();
});

describe("the mint wait's key", () => {
	it("sits under a prefix the `jobs` topic invalidates", () => {
		const prefixes = TOPIC_KEYS.jobs().map((key) => JSON.stringify(key));
		expect(prefixes).toContain(JSON.stringify([MINT_WAIT_KEY[0]]));
		expect(mintWaitKey(CLUSTER).slice(0, 2)).toEqual([...MINT_WAIT_KEY]);
		expect(mintWaitKey(CLUSTER)).toContain(CLUSTER);
	});
});

describe("createMintWait", () => {
	it("resolves when the jobs topic's keys are invalidated — and not before", async () => {
		const wait = createMintWait(client, mintWaitKey(CLUSTER), manualTimers());
		wait.arm();
		const changed = wait.changed(FAR, new AbortController().signal);
		expect(await settled(changed)).toBe(false);
		await client.invalidateQueries({ queryKey: ["jobs"] });
		expect(await settled(changed)).toBe(true);
	});

	it("an invalidation of some other key does not end it", async () => {
		const wait = createMintWait(client, mintWaitKey(CLUSTER), manualTimers());
		wait.arm();
		client.setQueryData(["clusters", "x"], 1);
		const changed = wait.changed(FAR, new AbortController().signal);
		await client.invalidateQueries({ queryKey: ["clusters"] });
		expect(await settled(changed)).toBe(false);
	});

	it("does not lose a change that lands between the arm and the wait (a read in flight)", async () => {
		const wait = createMintWait(client, mintWaitKey(CLUSTER), manualTimers());
		wait.arm();
		await client.invalidateQueries({ queryKey: ["jobs"] });
		expect(await settled(wait.changed(FAR, new AbortController().signal))).toBe(true);
	});

	it("re-arming clears the mark: the next wait needs a NEW change", async () => {
		const wait = createMintWait(client, mintWaitKey(CLUSTER), manualTimers());
		wait.arm();
		await client.invalidateQueries({ queryKey: ["jobs"] });
		wait.arm();
		const changed = wait.changed(FAR, new AbortController().signal);
		expect(await settled(changed)).toBe(false);
		await client.invalidateQueries({ queryKey: ["jobs"] });
		expect(await settled(changed)).toBe(true);
	});

	it("is bounded: it ends when the request's window closes, with one timer and no interval", async () => {
		const manual = manualTimers();
		const now = Date.parse("2026-11-20T10:00:00.000Z");
		const delays: number[] = [];
		const wait = createMintWait(client, mintWaitKey(CLUSTER), {
			now: () => now,
			timers: {
				setTimeout: (fn, ms) => {
					delays.push(ms);
					return manual.timers.setTimeout(fn);
				},
				clearTimeout: manual.timers.clearTimeout,
			},
		});
		wait.arm();
		const changed = wait.changed(now + 600_000, new AbortController().signal);
		expect(delays).toEqual([600_000]);
		expect(await settled(changed)).toBe(false);
		manual.pending[0]();
		expect(await settled(changed)).toBe(true);
	});

	it("a deadline further off than a timer can hold is clamped — it never overflows into firing at once", () => {
		const delays: number[] = [];
		const manual = manualTimers();
		const wait = createMintWait(client, mintWaitKey(CLUSTER), {
			now: () => Date.parse("2026-11-20T10:00:00.000Z"),
			timers: {
				setTimeout: (fn, ms) => {
					delays.push(ms);
					return manual.timers.setTimeout(fn);
				},
				clearTimeout: manual.timers.clearTimeout,
			},
		});
		wait.arm();
		void wait.changed(FAR, new AbortController().signal);
		expect(delays).toEqual([MAX_TIMER_MS]);
	});

	it("ends at once when it is cancelled, and when it was cancelled before it began", async () => {
		const wait = createMintWait(client, mintWaitKey(CLUSTER), manualTimers());
		wait.arm();
		const controller = new AbortController();
		const changed = wait.changed(FAR, controller.signal);
		expect(await settled(changed)).toBe(false);
		controller.abort();
		expect(await settled(changed)).toBe(true);
		expect(await settled(wait.changed(FAR, controller.signal))).toBe(true);
	});

	it("reads again when a hidden tab is looked at — a hint may have been missed while it was hidden", async () => {
		const listeners: Array<() => void> = [];
		const visibility = {
			visibilityState: "visible",
			addEventListener: (_type: "visibilitychange", listener: () => void) => {
				listeners.push(listener);
			},
			removeEventListener: () => {},
		};
		const wait = createMintWait(client, mintWaitKey(CLUSTER), { ...manualTimers(), visibility });
		wait.arm();
		const changed = wait.changed(FAR, new AbortController().signal);
		expect(listeners).toHaveLength(1);
		listeners[0]();
		expect(await settled(changed)).toBe(true);
	});
});
