// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6115 PR B, R8: one stream per browser per org. Both elections are exercised — Web Locks over an
// in-memory lock manager with the browser's queueing semantics, and the BroadcastChannel lease (the
// insecure-context path) over an in-memory channel under fake timers — nothing here reads a clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ChannelLike,
	electLeader,
	type Election,
	LEASE_BEAT_MS,
	LEASE_MISSED_BEATS,
	type LockManagerLike,
	newElectionRegistry,
} from "@/lib/realtime/client/leader";
import { FakeWebLocks } from "./fake-web-locks";
import { memoryChannels, settle, type TestChannel } from "./harness";

/** An in-memory Web Locks manager: exclusive, FIFO, and `signal` leaves the queue. */
function memoryLocks(): LockManagerLike {
	const held = new Set<string>();
	const queues = new Map<string, Array<() => void>>();
	const release = (name: string) => {
		held.delete(name);
		const next = queues.get(name)?.shift();
		if (next) next();
	};
	return {
		request(name, options, callback) {
			return new Promise((resolve, reject) => {
				const grant = () => {
					held.add(name);
					callback().then(
						(v) => {
							release(name);
							resolve(v);
						},
						(e: unknown) => {
							release(name);
							reject(e);
						},
					);
				};
				if (!held.has(name)) return grant();
				const queue = queues.get(name) ?? [];
				queues.set(name, queue);
				queue.push(grant);
				options.signal?.addEventListener("abort", () => {
					const i = queue.indexOf(grant);
					if (i >= 0) {
						queue.splice(i, 1);
						reject(new DOMException("aborted", "AbortError"));
					}
				});
			});
		},
	};
}

/** A tab: its election plus a record of when it led. */
function tab(build: (onLead: (signal: AbortSignal) => void) => Election) {
	const record = { leading: false, leads: 0 };
	const election = build((signal) => {
		record.leading = true;
		record.leads += 1;
		signal.addEventListener("abort", () => {
			record.leading = false;
		});
	});
	return { record, election };
}

/** Lets queued lock grants and their callbacks run (event-loop turns, not time). */
const flush = () => settle(5);

describe("Web Locks election (secure context)", () => {
	it("exactly one tab leads; stopping it hands over to the next queued tab", async () => {
		const locks = memoryLocks();
		const open = () => null;
		const tabs = [0, 1, 2].map(() =>
			tab((onLead) => electLeader({ registry: newElectionRegistry(), name: "alethia-events:acme", locks, openChannel: open, onLead })),
		);
		await flush();
		expect(tabs.map((t) => t.record.leading)).toEqual([true, false, false]);

		tabs[0]!.election.stop();
		await flush();
		expect(tabs.map((t) => t.record.leading)).toEqual([false, true, false]);
		expect(tabs[1]!.election.isLeader()).toBe(true);

		tabs[2]!.election.stop(); // a queued tab leaves without ever leading
		tabs[1]!.election.stop();
		await flush();
		expect(tabs.map((t) => t.record.leads)).toEqual([1, 1, 0]);
	});

	it("orgs do not share a lock", async () => {
		const locks = memoryLocks();
		const a = tab((onLead) => electLeader({ registry: newElectionRegistry(), name: "alethia-events:acme", locks, openChannel: () => null, onLead }));
		const b = tab((onLead) => electLeader({ registry: newElectionRegistry(), name: "alethia-events:~", locks, openChannel: () => null, onLead }));
		await flush();
		expect([a.record.leading, b.record.leading]).toEqual([true, true]);
		a.election.stop();
		b.election.stop();
	});
});

describe("BroadcastChannel lease (insecure context: no navigator.locks)", () => {
	// In-memory channels (delivery on a microtask, no real I/O), each one mutable to model a crashed tab.
	let hub = memoryChannels();
	let opened: TestChannel[] = hub.opened;
	const openChannel = (name: string): ChannelLike => hub.open(name);
	beforeEach(() => {
		hub = memoryChannels();
		opened = hub.opened;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** Advances fake time in beat-sized steps; channel deliveries (microtasks) settle within each step. */
	async function advance(ms: number) {
		const step = 250;
		for (let t = 0; t < ms; t += step) await vi.advanceTimersByTimeAsync(step);
	}

	const leaseTab = (id: string, visible: () => boolean = () => true, name = "alethia-events:u1:acme") =>
		tab((onLead) =>
			electLeader({ registry: newElectionRegistry(), name, locks: null, openChannel, onLead, tabId: id, random: () => 0, isVisible: visible }),
		);

	it("a lone tab claims after about one beat", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
		const a = leaseTab("a");
		await advance(LEASE_BEAT_MS + 500);
		expect(a.record.leading).toBe(true);
		a.election.stop();
	});

	it("exactly one of several tabs leads, the others hear its beat and stay followers", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
		const tabs = ["c", "a", "b"].map((id) => leaseTab(id));
		await advance(10 * LEASE_BEAT_MS);
		expect(tabs.filter((t) => t.record.leading)).toHaveLength(1);
		expect(tabs.reduce((n, t) => n + t.record.leads, 0)).toBe(1); // and nobody else ever led
		for (const t of tabs) t.election.stop();
	});

	it("two leaders that claimed at once resolve to the lowest tab id", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
		const c = leaseTab("c");
		const a = leaseTab("a");
		// Both claim without hearing each other (a partition), then the channel heals.
		opened[0]!.muted = true;
		opened[1]!.muted = true;
		await advance(2 * LEASE_BEAT_MS);
		expect([c.record.leading, a.record.leading]).toEqual([true, true]);
		opened[0]!.muted = false;
		opened[1]!.muted = false;
		await advance(2 * LEASE_BEAT_MS);
		expect([c.record.leading, a.record.leading]).toEqual([false, true]);
		c.election.stop();
		a.election.stop();
	});

	it("the leader leaving hands over to a follower", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
		const a = leaseTab("a");
		await advance(2 * LEASE_BEAT_MS);
		const b = leaseTab("b");
		await advance(5 * LEASE_BEAT_MS);
		expect([a.record.leading, b.record.leading]).toEqual([true, false]);
		a.election.stop();
		await advance(2 * LEASE_BEAT_MS);
		expect(b.record.leading).toBe(true);
		b.election.stop();
	});

	it("a leader that dies without a word is replaced after the missed beats", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
		const a = leaseTab("a");
		await advance(2 * LEASE_BEAT_MS);
		const b = leaseTab("b");
		await advance(4 * LEASE_BEAT_MS);
		expect(b.record.leading).toBe(false);
		// A crashed tab: its channel goes silent, no release message.
		opened[0]!.muted = true;
		await advance((LEASE_MISSED_BEATS - 1) * LEASE_BEAT_MS);
		expect(b.record.leading).toBe(false);
		await advance(2 * LEASE_BEAT_MS + 500);
		expect(b.record.leading).toBe(true);
		b.election.stop();
	});

	it("works where crypto.randomUUID does not exist (an insecure context), with no injected tab id", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
		const real = globalThis.crypto;
		// What a plain-HTTP page has: getRandomValues, and no randomUUID.
		vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
		try {
			let election: Election | undefined;
			const a = tab((onLead) => {
				election = electLeader({ registry: newElectionRegistry(), name: "alethia-events:u1:acme", locks: null, openChannel, onLead });
				return election;
			});
			await advance(LEASE_BEAT_MS + 500);
			expect(a.record.leading).toBe(true);
			election?.stop();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("two leaders that meet: the visible one keeps it over a hidden one with a LOWER id", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
		let aVisible = true;
		const a = leaseTab("a", () => aVisible);
		const z = leaseTab("z");
		// A partition: both claim without hearing each other.
		opened[0]!.muted = true;
		opened[1]!.muted = true;
		await advance(2 * LEASE_BEAT_MS);
		expect([a.record.leading, z.record.leading]).toEqual([true, true]);
		aVisible = false; // a goes to the background, still inside its grace
		opened[0]!.muted = false;
		opened[1]!.muted = false;
		await advance(2 * LEASE_BEAT_MS);
		expect([a.record.leading, z.record.leading]).toEqual([false, true]);
		a.election.stop();
		z.election.stop();
	});

	it("a hidden leader yields after the grace, a visible follower takes over, and the hidden one does not reclaim", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
		let aVisible = true;
		const a = leaseTab("a", () => aVisible);
		await advance(2 * LEASE_BEAT_MS);
		const b = leaseTab("b");
		await advance(3 * LEASE_BEAT_MS);
		expect([a.record.leading, b.record.leading]).toEqual([true, false]);
		aVisible = false;
		await advance(8000);
		expect(a.record.leading).toBe(true); // inside the 10 s grace: still leading
		await advance(4 * LEASE_BEAT_MS);
		expect([a.record.leading, b.record.leading]).toEqual([false, true]);
		await advance(10 * LEASE_BEAT_MS);
		expect([a.record.leads, b.record.leads]).toEqual([1, 1]); // no flapping
		a.election.stop();
		b.election.stop();
	});

	it("a hidden follower never claims, even when the leader is gone; it claims once it is looked at", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
		let bVisible = false;
		const a = leaseTab("a");
		await advance(2 * LEASE_BEAT_MS);
		const b = leaseTab("b", () => bVisible);
		await advance(2 * LEASE_BEAT_MS);
		a.election.stop();
		await advance(10 * LEASE_BEAT_MS);
		expect(b.record.leads).toBe(0); // never, not "not at the end" (a hidden leader would yield)
		bVisible = true;
		await advance(2 * LEASE_BEAT_MS);
		expect(b.record.leading).toBe(true);
		b.election.stop();
	});

	it("a lease election started twice in one document leaves ONE voter: the superseded one never leads", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
		const docB = newElectionRegistry();
		const a = leaseTab("a");
		await advance(2 * LEASE_BEAT_MS);
		const leaked = tab((onLead) =>
			electLeader({ registry: docB, name: "alethia-events:u1:acme", locks: null, openChannel, onLead, tabId: "b1", random: () => 0 }),
		);
		const live = tab((onLead) =>
			electLeader({ registry: docB, name: "alethia-events:u1:acme", locks: null, openChannel, onLead, tabId: "b2", random: () => 0 }),
		);
		a.election.stop();
		await advance(5 * LEASE_BEAT_MS);
		expect([leaked.record.leads, live.record.leads]).toEqual([0, 1]);
		live.election.stop();
	});

	it("with no BroadcastChannel at all, a tab streams for itself", () => {
		const a = tab((onLead) => electLeader({ registry: newElectionRegistry(), name: "x", locks: null, openChannel: () => null, onLead }));
		expect(a.record.leading).toBe(true);
		a.election.stop();
		expect(a.record.leading).toBe(false);
	});
});

describe("one request per document, whatever the caller does (found live: StrictMode double mounts)", () => {
	const NAME = "alethia-events:u1:acme";

	it("Web Locks: a second election in the same document supersedes the first — one request left", async () => {
		const locks = new FakeWebLocks();
		const docA = newElectionRegistry();
		const docB = newElectionRegistry();
		const a = tab((onLead) => electLeader({ registry: docA, name: NAME, locks: locks.client("A"), openChannel: () => null, onLead }));
		await flush();
		const leaked = tab((onLead) => electLeader({ registry: docB, name: NAME, locks: locks.client("B"), openChannel: () => null, onLead }));
		const live = tab((onLead) => electLeader({ registry: docB, name: NAME, locks: locks.client("B"), openChannel: () => null, onLead }));
		await flush();
		expect(locks.requestsOf("B", NAME)).toBe(1);
		a.election.stop();
		await flush();
		expect([leaked.record.leads, live.record.leads]).toEqual([0, 1]);
		expect(locks.query().held).toEqual([{ name: NAME, clientId: "B" }]);
		live.election.stop();
	});

	it("Web Locks: a request whose abort is LOST stays the document's only one — a later election rides it, and leads", async () => {
		const locks = new FakeWebLocks();
		locks.abortsLost = true;
		const docB = newElectionRegistry();
		const a = tab((onLead) => electLeader({ registry: newElectionRegistry(), name: NAME, locks: locks.client("A"), openChannel: () => null, onLead }));
		await flush();
		const stale = tab((onLead) => electLeader({ registry: docB, name: NAME, locks: locks.client("B"), openChannel: () => null, onLead }));
		stale.election.stop();
		await flush(); // the give-up runs, and its abort is lost: the request stays queued
		expect(locks.requestsOf("B", NAME)).toBe(1);
		const live = tab((onLead) => electLeader({ registry: docB, name: NAME, locks: locks.client("B"), openChannel: () => null, onLead }));
		await flush();
		expect(locks.requestsOf("B", NAME)).toBe(1); // no second request
		a.election.stop();
		await flush();
		expect([stale.record.leads, live.record.leads]).toEqual([0, 1]);
		live.election.stop();
		await flush();
		expect(locks.query()).toEqual({ held: [], pending: [] });
	});

	it("Web Locks: a request granted when nobody in the document wants it any more is released at once", async () => {
		const locks = new FakeWebLocks();
		locks.abortsLost = true;
		const a = tab((onLead) => electLeader({ registry: newElectionRegistry(), name: NAME, locks: locks.client("A"), openChannel: () => null, onLead }));
		await flush();
		const stale = tab((onLead) => electLeader({ registry: newElectionRegistry(), name: NAME, locks: locks.client("B"), openChannel: () => null, onLead }));
		stale.election.stop();
		await flush();
		a.election.stop();
		await flush();
		expect(stale.record.leads).toBe(0);
		expect(locks.query()).toEqual({ held: [], pending: [] });
	});

	it("Web Locks: stop + start in one task (StrictMode) KEEPS the document's place in the queue", async () => {
		const locks = new FakeWebLocks();
		const a = tab((onLead) => electLeader({ registry: newElectionRegistry(), name: NAME, locks: locks.client("A"), openChannel: () => null, onLead }));
		await flush();
		const docB = newElectionRegistry();
		const b1 = tab((onLead) => electLeader({ registry: docB, name: NAME, locks: locks.client("B"), openChannel: () => null, onLead }));
		const c = tab((onLead) => electLeader({ registry: newElectionRegistry(), name: NAME, locks: locks.client("C"), openChannel: () => null, onLead }));
		b1.election.stop();
		const b2 = tab((onLead) => electLeader({ registry: docB, name: NAME, locks: locks.client("B"), openChannel: () => null, onLead }));
		await flush();
		a.election.stop();
		await flush();
		expect([b1.record.leads, b2.record.leads, c.record.leads]).toEqual([0, 1, 0]); // B was ahead of C, and still is
		b2.election.stop();
		c.election.stop();
		await flush();
	});

	it("Web Locks: an election started while the lock is being GIVEN BACK does not lead on it; it re-queues", async () => {
		const locks = new FakeWebLocks();
		const docB = newElectionRegistry();
		const b1 = tab((onLead) => electLeader({ registry: docB, name: NAME, locks: locks.client("B"), openChannel: () => null, onLead }));
		await flush();
		const c = tab((onLead) => electLeader({ registry: newElectionRegistry(), name: NAME, locks: locks.client("C"), openChannel: () => null, onLead }));
		b1.election.stop();
		await Promise.resolve(); // the give-up has run: the lock is on its way back
		const b2 = tab((onLead) => electLeader({ registry: docB, name: NAME, locks: locks.client("B"), openChannel: () => null, onLead }));
		await flush();
		expect([b2.record.leading, c.record.leading]).toEqual([false, true]); // C was queued first
		expect(locks.requestsOf("B", NAME)).toBe(1); // B queued again, once
		c.election.stop();
		await flush();
		expect(b2.record.leading).toBe(true);
		b2.election.stop();
		await flush();
		expect(locks.query()).toEqual({ held: [], pending: [] });
	});

	it("two COPIES of this module in one document share the registry: one request (the bundler case, seen live)", async () => {
		const locks = new FakeWebLocks();
		const holder = electLeader({ registry: newElectionRegistry(), name: NAME, locks: locks.client("A"), openChannel: () => null, onLead: () => {} });
		await flush();
		Reflect.deleteProperty(globalThis, Symbol.for("alethia.realtime.elections"));
		vi.resetModules();
		const copy1 = await import("@/lib/realtime/client/leader");
		vi.resetModules();
		const copy2 = await import("@/lib/realtime/client/leader");
		expect(copy1.electLeader).not.toBe(copy2.electLeader); // really two module instances
		const e1 = copy1.electLeader({ name: NAME, locks: locks.client("B"), openChannel: () => null, onLead: () => {} });
		const e2 = copy2.electLeader({ name: NAME, locks: locks.client("B"), openChannel: () => null, onLead: () => {} });
		await flush();
		expect(locks.requestsOf("B", NAME)).toBe(1);
		e1.stop();
		e2.stop();
		holder.stop();
		await flush();
		expect(locks.query()).toEqual({ held: [], pending: [] });
		Reflect.deleteProperty(globalThis, Symbol.for("alethia.realtime.elections"));
	});
});
