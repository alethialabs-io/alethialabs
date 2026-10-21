// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6115: the change bus's fan-out. Driven through a fake transport (the tap and the reconnect hook are
// all the bus uses) and a PdpMemo whose PDP is a spy, so each rule is asserted on deliveries:
//   · each stream gets a notice ONCE, however many of its keys matched;
//   · the PDP filter applies only to a delivery reached through the org arm alone;
//   · the cursor moves on every routed notice, listened-to or not, and a reconnect resyncs everyone;
//   · the counters return to zero when every stream leaves (the /health leak counter).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability/log", () => {
	const noop = () => {};
	return { log: { child: () => ({ info: noop, warn: noop, error: noop }) } };
});
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/realtime/index", () => ({ getChangeTransport: vi.fn() }));

import type { Actor } from "@/lib/authz/types";
import {
	ChangeBus,
	MAX_PENDING_PER_STREAM,
	MAX_STREAMS_PER_USER,
	maxStreamsPerUser,
	type StreamSink,
	type Subscription,
} from "@/lib/realtime/bus";
import type { ChangeValue } from "@/lib/realtime/index";
import { PdpMemo } from "@/lib/realtime/pdp-memo";
import { type ChangeNotice, subscriptionKeys } from "@/lib/realtime/routing";
import type { Hint, ResyncReason } from "@/lib/realtime/topics";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "66666666-6666-4666-8666-666666666666";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER_USER = "77777777-7777-4777-8777-777777777777";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";

/** A transport that hands the bus its tap and reconnect hook, and lets the test fire them. */
function fakeTransport() {
	let tap: ((v: ChangeValue) => void) | null = null;
	let reconnect: (() => void) | null = null;
	return {
		tap: vi.fn((cb: (v: ChangeValue) => void) => {
			tap = cb;
			return () => {};
		}),
		onReconnect: vi.fn((cb: () => void) => {
			reconnect = cb;
			return () => {};
		}),
		emit(v: ChangeValue) {
			if (!tap) throw new Error("bus not started");
			tap(v);
		},
		reconnect() {
			reconnect?.();
		},
	};
}

/** A sink that records what a stream was sent. */
function recorder() {
	const hints: Array<{ hint: Hint }> = [];
	const resyncs: Array<{ reason: ResyncReason }> = [];
	const sink: StreamSink = {
		hint: (hint) => {
			hints.push({ hint });
		},
		resync: (reason) => {
			resyncs.push({ reason });
		},
	};
	return { sink, hints, resyncs };
}

/** A jobs notice. */
function job(over: Partial<ChangeNotice> = {}): ChangeNotice {
	return { kind: "change", t: "jobs", id: JOB, o: ORG, u: OTHER_USER, p: PROJECT, ...over };
}

const NO_CAPS = { fleetView: false, manageSupport: false };
const member: Actor = { credential: "session", userId: USER, orgId: ORG };
const memberKeys = subscriptionKeys(member, NO_CAPS);

/** Lets queued PDP decisions settle. */
async function settle(turns = 10): Promise<void> {
	for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** Subscribes, failing the test if the bus refused. */
function open(actor: Actor, keys: readonly string[], sink: StreamSink): Subscription {
	const sub = bus.subscribe(actor, keys, sink);
	if (!sub) throw new Error("the bus refused the stream");
	return sub;
}

let transport: ReturnType<typeof fakeTransport>;
let check: ReturnType<typeof vi.fn<(actor: Actor, projectId: string) => Promise<boolean>>>;
let bus: ChangeBus;

beforeEach(() => {
	transport = fakeTransport();
	check = vi.fn(async () => true);
	bus = new ChangeBus({ transport, memo: new PdpMemo({ check }) });
});

describe("fan-out", () => {
	it("delivers {t, id} to a stream on the org arm after the PDP allows the project", async () => {
		const r = recorder();
		bus.subscribe(member, memberKeys, r.sink);
		transport.emit(job());
		await settle();
		expect(check).toHaveBeenCalledWith(member, PROJECT);
		expect(r.hints.map((h) => h.hint)).toEqual([{ t: "jobs", id: JOB }]);
	});

	it("withholds the hint when the PDP denies the project", async () => {
		check.mockResolvedValue(false);
		const r = recorder();
		bus.subscribe(member, memberKeys, r.sink);
		transport.emit(job());
		await settle();
		expect(r.hints).toEqual([]);
		expect(bus.stats().filtered).toBe(1);
	});

	it("withholds the hint when the PDP throws (an error is a deny)", async () => {
		check.mockRejectedValue(new Error("pdp down"));
		const r = recorder();
		bus.subscribe(member, memberKeys, r.sink);
		transport.emit(job());
		await settle();
		expect(r.hints).toEqual([]);
	});

	it("never asks the PDP for a delivery reached through the owner arm", async () => {
		check.mockResolvedValue(false);
		const r = recorder();
		bus.subscribe(member, memberKeys, r.sink);
		// The member's own job in this org: the owner arm, unfiltered, as the jobs read is.
		transport.emit(job({ u: USER }));
		await settle();
		expect(check).not.toHaveBeenCalled();
		expect(r.hints).toHaveLength(1);
	});

	it("never asks the PDP for a project-less job on the org arm", async () => {
		const r = recorder();
		bus.subscribe(member, memberKeys, r.sink);
		transport.emit(job({ p: null }));
		await settle();
		expect(check).not.toHaveBeenCalled();
		expect(r.hints).toHaveLength(1);
	});

	it("delivers a person's own job only on the stream of the org the job belongs to", async () => {
		const here = recorder();
		const there = recorder();
		bus.subscribe(member, memberKeys, here.sink);
		const elsewhere: Actor = { credential: "session", userId: USER, orgId: OTHER_ORG };
		bus.subscribe(elsewhere, subscriptionKeys(elsewhere, NO_CAPS), there.sink);
		// Written by USER, stamped OTHER_ORG: it belongs to the OTHER_ORG stream alone.
		transport.emit(job({ o: OTHER_ORG, u: USER, p: null }));
		await settle();
		expect(here.hints).toEqual([]);
		expect(there.hints).toHaveLength(1);
	});

	it("delivers once to a stream matched by two keys (personal scope, o == u)", async () => {
		const personal: Actor = { credential: "session", userId: USER, orgId: USER };
		const r = recorder();
		bus.subscribe(personal, subscriptionKeys(personal, NO_CAPS), r.sink);
		transport.emit(job({ o: USER, u: USER, p: null }));
		await settle();
		expect(r.hints).toHaveLength(1);
	});

	it("never delivers to a stream of another org", async () => {
		const r = recorder();
		const elsewhere: Actor = { credential: "session", userId: USER, orgId: OTHER_ORG };
		bus.subscribe(elsewhere, subscriptionKeys(elsewhere, NO_CAPS), r.sink);
		transport.emit(job());
		await settle();
		expect(r.hints).toEqual([]);
		expect(check).not.toHaveBeenCalled();
	});

	it("never forwards the self-test echo to a stream", async () => {
		const r = recorder();
		bus.subscribe(member, memberKeys, r.sink);
		transport.emit({ kind: "selftest", nonce: "n1" });
		await settle();
		expect(r.hints).toEqual([]);
		expect(r.resyncs).toEqual([]);
	});

	it("keeps one stream's deliveries in notice order when the first waits on the PDP", async () => {
		let release: (v: boolean) => void = () => {};
		check.mockImplementationOnce(() => new Promise<boolean>((res) => (release = res)));
		const r = recorder();
		bus.subscribe(member, memberKeys, r.sink);
		const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		transport.emit(job({ id: first })); // org arm → PDP (pending)
		transport.emit(job({ id: second, u: USER })); // owner arm → no PDP, but must wait its turn
		await settle();
		expect(r.hints).toEqual([]);
		release(true);
		await settle();
		expect(r.hints.map((h) => h.hint.id)).toEqual([first, second]);
	});

	it("re-uses a memoised PDP answer instead of asking again", async () => {
		const r = recorder();
		bus.subscribe(member, memberKeys, r.sink);
		transport.emit(job());
		await settle();
		transport.emit(job());
		await settle();
		expect(check).toHaveBeenCalledTimes(1);
		expect(r.hints).toHaveLength(2);
	});
});

describe("resync", () => {
	it("tells every stream to resync on a LISTEN reconnect", () => {
		const a = recorder();
		const b = recorder();
		bus.subscribe(member, memberKeys, a.sink);
		bus.subscribe({ credential: "session", userId: OTHER_USER, orgId: OTHER_ORG }, [`o:${OTHER_ORG}`], b.sink);
		transport.reconnect();
		expect(a.resyncs.map((r) => r.reason)).toEqual(["reconnect"]);
		expect(b.resyncs.map((r) => r.reason)).toEqual(["reconnect"]);
	});

	it("resyncs a stream whose keys changed on re-auth, and routes by the new keys", async () => {
		const r = recorder();
		const sub = open(member, memberKeys, r.sink);
		sub.update(member, [`o:${OTHER_ORG}`]);
		expect(r.resyncs.map((x) => x.reason)).toEqual(["keys-changed"]);
		transport.emit(job());
		await settle();
		expect(r.hints).toEqual([]);
	});

	it("does not resync a stream whose keys did not change", () => {
		const r = recorder();
		const sub = open(member, memberKeys, r.sink);
		sub.update(member, [...memberKeys].reverse());
		expect(r.resyncs).toEqual([]);
	});
});

describe("bookkeeping", () => {
	it("starts the transport once, on the first subscribe", () => {
		bus.subscribe(member, memberKeys, recorder().sink);
		bus.subscribe(member, memberKeys, recorder().sink);
		expect(transport.tap).toHaveBeenCalledTimes(1);
		expect(transport.onReconnect).toHaveBeenCalledTimes(1);
	});

	it("returns streams and keys to zero when every stream closes", () => {
		const a = open(member, memberKeys, recorder().sink);
		const b = open({ credential: "session", userId: OTHER_USER, orgId: OTHER_ORG }, [`o:${OTHER_ORG}`], recorder().sink);
		expect(bus.stats()).toMatchObject({ streams: 2, keys: 3, users: 2, maxPerUser: 1 });
		a.close();
		b.close();
		b.close(); // idempotent
		expect(bus.stats()).toMatchObject({ streams: 0, keys: 0, users: 0, maxPerUser: 0 });
	});

	it("delivers nothing to a stream that closed while its PDP answer was pending", async () => {
		let release: (v: boolean) => void = () => {};
		check.mockImplementationOnce(() => new Promise<boolean>((res) => (release = res)));
		const r = recorder();
		const sub = open(member, memberKeys, r.sink);
		transport.emit(job());
		sub.close();
		release(true);
		await settle();
		expect(r.hints).toEqual([]);
	});

	it("caps one person's streams per process, counts the refusals, and frees a slot on close", () => {
		const subs = Array.from({ length: MAX_STREAMS_PER_USER }, () =>
			open(member, memberKeys, recorder().sink),
		);
		expect(bus.hasRoomFor(USER)).toBe(false);
		expect(bus.subscribe(member, memberKeys, recorder().sink)).toBeNull();
		expect(bus.stats()).toMatchObject({
			streams: MAX_STREAMS_PER_USER,
			maxPerUser: MAX_STREAMS_PER_USER,
			refused: 1,
		});
		// Another person is unaffected.
		expect(bus.hasRoomFor(OTHER_USER)).toBe(true);
		subs[0].close();
		expect(bus.hasRoomFor(USER)).toBe(true);
	});

	it("bounds the PDP wait per stream: past the bound it drops the waiting hints and resyncs once", async () => {
		let release: (v: boolean) => void = () => {};
		const gate = new Promise<boolean>((res) => (release = res));
		check.mockImplementation(() => gate);
		const r = recorder();
		bus.subscribe(member, memberKeys, r.sink);
		const project = (i: number) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
		// One delivery is already waiting on the PDP when the burst arrives.
		transport.emit(job({ p: project(0) }));
		await settle();
		expect(check).toHaveBeenCalledTimes(1);
		const burst = MAX_PENDING_PER_STREAM + 5;
		for (let i = 1; i <= burst; i++) transport.emit(job({ p: project(i) }));
		await settle();
		expect(r.resyncs).toEqual([]); // not before the queue has drained
		// The in-flight answer arrives AFTER the overflow: its `true` is discarded, not delivered.
		release(true);
		await settle(20 * burst);
		expect(check).toHaveBeenCalledTimes(1); // nothing queued behind the overflow asked the PDP
		expect(r.hints).toEqual([]);
		expect(r.resyncs.map((x) => x.reason)).toEqual(["backpressure"]);
		expect(bus.stats().dropped).toBe(burst + 1);
		// Drained: the next notice is delivered normally.
		transport.emit(job({ p: null }));
		await settle();
		expect(r.hints).toHaveLength(1);
	});

	it("counts dropped hints reported by a stream", () => {
		bus.noteDropped(3);
		expect(bus.stats().dropped).toBe(3);
	});

	it("resolves a self-test wait on its nonce, and times out without it", async () => {
		vi.useFakeTimers();
		try {
			const heard = bus.awaitSelfTest("n1", 5000);
			const missed = bus.awaitSelfTest("n2", 5000);
			transport.emit({ kind: "selftest", nonce: "n1" });
			await expect(heard).resolves.toBe(true);
			vi.advanceTimersByTime(5000);
			await expect(missed).resolves.toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("evicts a user's memoised answers on re-auth", async () => {
		bus.subscribe(member, memberKeys, recorder().sink);
		transport.emit(job());
		await settle();
		bus.evictUser(USER);
		transport.emit(job());
		await settle();
		expect(check).toHaveBeenCalledTimes(2);
	});
});

describe("PdpMemo", () => {
	it("expires an answer after its TTL", async () => {
		let now = 0;
		const memo = new PdpMemo({ check, ttlMs: 60_000, now: () => now });
		await memo.allowed(member, PROJECT);
		now = 60_000;
		expect(memo.peek(member, PROJECT)).toBe(true);
		now = 60_001;
		expect(memo.peek(member, PROJECT)).toBeUndefined();
	});

	it("evicts the least recently used answer past its cap", async () => {
		const memo = new PdpMemo({ check, max: 2 });
		const p = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
		await memo.allowed(member, p(1));
		await memo.allowed(member, p(2));
		memo.peek(member, p(1)); // touch 1: 2 is now the oldest
		await memo.allowed(member, p(3));
		expect(memo.size).toBe(2);
		expect(memo.peek(member, p(2))).toBeUndefined();
		expect(memo.peek(member, p(1))).toBe(true);
	});

	it("keys an answer by user AND org: the same project asked from another org is asked again", async () => {
		const memo = new PdpMemo({ check });
		await memo.allowed(member, PROJECT);
		await memo.allowed({ credential: "session", userId: USER, orgId: OTHER_ORG }, PROJECT);
		expect(check).toHaveBeenCalledTimes(2);
	});

	it("reads a PDP answer slower than its timeout as a deny, and does not cache it", async () => {
		check.mockImplementationOnce(() => new Promise<boolean>(() => {}));
		const memo = new PdpMemo({ check, timeoutMs: 20 });
		await expect(memo.allowed(member, PROJECT)).resolves.toBe(false);
		expect(memo.peek(member, PROJECT)).toBeUndefined();
	});

	it("does not cache a PDP error", async () => {
		check.mockRejectedValueOnce(new Error("down"));
		const memo = new PdpMemo({ check });
		await expect(memo.allowed(member, PROJECT)).resolves.toBe(false);
		expect(memo.peek(member, PROJECT)).toBeUndefined();
	});

	it("evictUser forgets only that user", async () => {
		const memo = new PdpMemo({ check });
		const other: Actor = { credential: "session", userId: OTHER_USER, orgId: ORG };
		await memo.allowed(member, PROJECT);
		await memo.allowed(other, PROJECT);
		memo.evictUser(USER);
		expect(memo.peek(member, PROJECT)).toBeUndefined();
		expect(memo.peek(other, PROJECT)).toBe(true);
	});
});

describe("maxStreamsPerUser", () => {
	it("is 8 unless ALETHIA_REALTIME_MAX_STREAMS_PER_USER is a positive integer", () => {
		const before = process.env.ALETHIA_REALTIME_MAX_STREAMS_PER_USER;
		try {
			delete process.env.ALETHIA_REALTIME_MAX_STREAMS_PER_USER;
			expect(maxStreamsPerUser()).toBe(MAX_STREAMS_PER_USER);
			process.env.ALETHIA_REALTIME_MAX_STREAMS_PER_USER = "1200";
			expect(maxStreamsPerUser()).toBe(1200);
			for (const bad of ["0", "-3", "1.5", "lots"]) {
				process.env.ALETHIA_REALTIME_MAX_STREAMS_PER_USER = bad;
				expect(maxStreamsPerUser()).toBe(MAX_STREAMS_PER_USER);
			}
		} finally {
			if (before === undefined) delete process.env.ALETHIA_REALTIME_MAX_STREAMS_PER_USER;
			else process.env.ALETHIA_REALTIME_MAX_STREAMS_PER_USER = before;
		}
	});

	it("a bus built with a higher cap admits that many streams for one person", () => {
		const big = new ChangeBus({ transport: fakeTransport(), maxStreamsPerUser: 20 });
		for (let i = 0; i < 20; i++) expect(big.subscribe(member, memberKeys, recorder().sink)).not.toBeNull();
		expect(big.subscribe(member, memberKeys, recorder().sink)).toBeNull();
	});
});
