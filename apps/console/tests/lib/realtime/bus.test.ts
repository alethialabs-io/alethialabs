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
import { ChangeBus, type StreamSink } from "@/lib/realtime/bus";
import type { ChangeValue } from "@/lib/realtime/index";
import { PdpMemo } from "@/lib/realtime/pdp-memo";
import type { ChangeNotice } from "@/lib/realtime/routing";
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
	const hints: Array<{ hint: Hint; cursor: string }> = [];
	const resyncs: Array<{ reason: ResyncReason; cursor: string }> = [];
	const sink: StreamSink = {
		hint: (hint, cursor) => hints.push({ hint, cursor }),
		resync: (reason, cursor) => resyncs.push({ reason, cursor }),
	};
	return { sink, hints, resyncs };
}

/** A jobs notice. */
function job(over: Partial<ChangeNotice> = {}): ChangeNotice {
	return { kind: "change", t: "jobs", id: JOB, o: ORG, u: OTHER_USER, p: PROJECT, ...over };
}

const member: Actor = { userId: USER, orgId: ORG };
const memberKeys = [`o:${ORG}`, `u:${USER}`, `ou:${ORG}:${USER}`];

/** Lets queued PDP decisions settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
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
		// The member's own job, in a project they can no longer view: RLS still returns it to them.
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

	it("delivers once to a stream matched by two keys (personal scope, o == u)", async () => {
		const personal: Actor = { userId: USER, orgId: USER };
		const r = recorder();
		bus.subscribe(personal, [`o:${USER}`, `u:${USER}`, `ou:${USER}:${USER}`], r.sink);
		transport.emit(job({ o: USER, u: USER, p: null }));
		await settle();
		expect(r.hints).toHaveLength(1);
	});

	it("never delivers to a stream of another org", async () => {
		const r = recorder();
		bus.subscribe({ userId: USER, orgId: OTHER_ORG }, [`o:${OTHER_ORG}`, `u:${USER}`], r.sink);
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
		expect(Number(r.hints[0].cursor)).toBeLessThan(Number(r.hints[1].cursor));
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

describe("cursor and resync", () => {
	it("moves a stream's cursor on every routed notice, even one it was filtered out of", async () => {
		check.mockResolvedValue(false);
		const before = bus.cursorFor(memberKeys);
		bus.start();
		transport.emit(job()); // nobody subscribed yet: the cursor still has to move
		bus.subscribe(member, memberKeys, recorder().sink);
		expect(bus.cursorFor(memberKeys)).not.toBe(before);
	});

	it("does not move the cursor of a stream whose keys a notice did not route to", () => {
		const keys = [`o:${OTHER_ORG}`, `u:${USER}`];
		const before = bus.cursorFor(keys);
		bus.start();
		transport.emit(job());
		expect(bus.cursorFor(keys)).toBe(before);
	});

	it("tells every stream to resync on a LISTEN reconnect", () => {
		const a = recorder();
		const b = recorder();
		bus.subscribe(member, memberKeys, a.sink);
		bus.subscribe({ userId: OTHER_USER, orgId: OTHER_ORG }, [`o:${OTHER_ORG}`], b.sink);
		transport.reconnect();
		expect(a.resyncs.map((r) => r.reason)).toEqual(["reconnect"]);
		expect(b.resyncs.map((r) => r.reason)).toEqual(["reconnect"]);
	});

	it("resyncs a stream whose keys changed on re-auth, and routes by the new keys", async () => {
		const r = recorder();
		const sub = bus.subscribe(member, memberKeys, r.sink);
		sub.update(member, [`o:${OTHER_ORG}`]);
		expect(r.resyncs.map((x) => x.reason)).toEqual(["keys-changed"]);
		transport.emit(job());
		await settle();
		expect(r.hints).toEqual([]);
	});

	it("does not resync a stream whose keys did not change", () => {
		const r = recorder();
		const sub = bus.subscribe(member, memberKeys, r.sink);
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
		const a = bus.subscribe(member, memberKeys, recorder().sink);
		const b = bus.subscribe({ userId: OTHER_USER, orgId: OTHER_ORG }, [`o:${OTHER_ORG}`], recorder().sink);
		expect(bus.stats()).toMatchObject({ streams: 2, keys: 4 });
		a.close();
		b.close();
		b.close(); // idempotent
		expect(bus.stats()).toMatchObject({ streams: 0, keys: 0 });
	});

	it("delivers nothing to a stream that closed while its PDP answer was pending", async () => {
		let release: (v: boolean) => void = () => {};
		check.mockImplementationOnce(() => new Promise<boolean>((res) => (release = res)));
		const r = recorder();
		const sub = bus.subscribe(member, memberKeys, r.sink);
		transport.emit(job());
		sub.close();
		release(true);
		await settle();
		expect(r.hints).toEqual([]);
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
		await memo.allowed({ userId: USER, orgId: OTHER_ORG }, PROJECT);
		expect(check).toHaveBeenCalledTimes(2);
	});

	it("does not cache a PDP error", async () => {
		check.mockRejectedValueOnce(new Error("down"));
		const memo = new PdpMemo({ check });
		await expect(memo.allowed(member, PROJECT)).resolves.toBe(false);
		expect(memo.peek(member, PROJECT)).toBeUndefined();
	});

	it("evictUser forgets only that user", async () => {
		const memo = new PdpMemo({ check });
		const other: Actor = { userId: OTHER_USER, orgId: ORG };
		await memo.allowed(member, PROJECT);
		await memo.allowed(other, PROJECT);
		memo.evictUser(USER);
		expect(memo.peek(member, PROJECT)).toBeUndefined();
		expect(memo.peek(other, PROJECT)).toBe(true);
	});
});
