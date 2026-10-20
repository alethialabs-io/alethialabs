// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6115 PR B, R8: one stream per browser per org. Both elections are exercised — Web Locks over an
// in-memory lock manager with the browser's queueing semantics, and the BroadcastChannel lease (the
// insecure-context path) over Node 22's real BroadcastChannel under fake timers.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ChannelLike,
	electLeader,
	type Election,
	LEASE_BEAT_MS,
	LEASE_MISSED_BEATS,
	type LockManagerLike,
} from "@/lib/realtime/client/leader";

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

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Web Locks election (secure context)", () => {
	it("exactly one tab leads; stopping it hands over to the next queued tab", async () => {
		const locks = memoryLocks();
		const open = () => null;
		const tabs = [0, 1, 2].map(() =>
			tab((onLead) => electLeader({ name: "alethia-events:acme", locks, openChannel: open, onLead })),
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
		const a = tab((onLead) => electLeader({ name: "alethia-events:acme", locks, openChannel: () => null, onLead }));
		const b = tab((onLead) => electLeader({ name: "alethia-events:~", locks, openChannel: () => null, onLead }));
		await flush();
		expect([a.record.leading, b.record.leading]).toEqual([true, true]);
		a.election.stop();
		b.election.stop();
	});
});

describe("BroadcastChannel lease (insecure context: no navigator.locks)", () => {
	// Real channels, wrapped so a test can silence one (a crashed tab sends nothing, not even a release).
	const opened: Array<{ channel: BroadcastChannel; muted: boolean }> = [];
	const openChannel = (name: string): ChannelLike => {
		const entry = { channel: new BroadcastChannel(name), muted: false };
		opened.push(entry);
		return {
			postMessage: (m) => {
				if (!entry.muted) entry.channel.postMessage(m);
			},
			addEventListener: (t, l) => entry.channel.addEventListener(t, l),
			removeEventListener: (t, l) => entry.channel.removeEventListener(t, l),
			close: () => entry.channel.close(),
		};
	};
	afterEach(() => {
		vi.useRealTimers();
		for (const e of opened.splice(0)) e.channel.close();
	});

	/** Advances fake time while letting BroadcastChannel messages (real I/O) get delivered. */
	async function advance(ms: number) {
		const step = 250;
		for (let t = 0; t < ms; t += step) {
			await vi.advanceTimersByTimeAsync(step);
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
		}
	}

	const leaseTab = (id: string, visible: () => boolean = () => true, name = "alethia-events:u1:acme") =>
		tab((onLead) =>
			electLeader({ name, locks: null, openChannel, onLead, tabId: id, random: () => 0, isVisible: visible }),
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
				election = electLeader({ name: "alethia-events:u1:acme", locks: null, openChannel, onLead });
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

	it("with no BroadcastChannel at all, a tab streams for itself", () => {
		const a = tab((onLead) => electLeader({ name: "x", locks: null, openChannel: () => null, onLead }));
		expect(a.record.leading).toBe(true);
		a.election.stop();
		expect(a.record.leading).toBe(false);
	});
});
