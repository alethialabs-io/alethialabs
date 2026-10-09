// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The two SSE routes read a backlog before they subscribe to live rows and start the heartbeat.
// A client that disconnects WHILE that read is in flight fires its abort before the route has
// anything to tear down, so the route must look at the signal again once the read settles — an
// abort listener added after the read never hears an abort that already happened (#5823). Each
// test below holds the backlog read open, aborts, releases it, and asserts that nothing was left
// running: no live subscription and no live heartbeat interval.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A channel transport the test can observe: the live listeners per key, and what unsubscribed. */
interface FakeTransport {
	listeners: Map<string, (payload: string) => void>;
	unsubscribed: string[];
}

const state = vi.hoisted(() => {
	/** A fresh fake transport. */
	const transport = (): FakeTransport => ({ listeners: new Map(), unsubscribed: [] });
	/** The held backlog read: `started` resolves when the route asks, `release` lets it return. */
	const gate = {
		started: Promise.resolve(),
		markStarted: () => {},
		release: () => {},
		held: Promise.resolve(),
	};
	return { realtime: transport(), support: transport(), gate };
});

/** Re-arm the gate so the next list read blocks until `state.gate.release()` is called. */
function armGate(): void {
	state.gate.started = new Promise<void>((resolve) => {
		state.gate.markStarted = resolve;
	});
	state.gate.held = new Promise<void>((resolve) => {
		state.gate.release = resolve;
	});
}

/** Subscribe `fn` on `t` under `key`; the returned function records the unsubscribe. */
function subscribeOn(t: FakeTransport, key: string, fn: (payload: string) => void): () => void {
	t.listeners.set(key, fn);
	return () => {
		t.listeners.delete(key);
		t.unsubscribed.push(key);
	};
}

vi.mock("@/lib/auth/owner", () => ({ getOwner: async () => "user-1" }));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: async () => ({ userId: "user-1", orgId: "org-1" }) }));
vi.mock("@/lib/authz/guard", () => ({ authorizeUserId: async () => null }));
vi.mock("@/lib/support/scope", () => ({ isSupportCaseVisible: async () => true }));
vi.mock("@/lib/realtime", () => ({
	getRealtimeTransport: () => ({
		subscribe: (key: string, fn: (p: string) => void) => subscribeOn(state.realtime, key, fn),
	}),
	getSupportMessageTransport: () => ({
		subscribe: (key: string, fn: (p: string) => void) => subscribeOn(state.support, key, fn),
	}),
}));
vi.mock("@/lib/db", () => {
	/**
	 * A drizzle-shaped chain: `.limit()` is a single-row lookup (the job's owner, the support
	 * cursor) and answers at once; `.orderBy()` is the backlog list read and waits on the gate.
	 */
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: async () => [{ org_id: "org-1", user_id: "user-1", created_at: new Date(0) }],
		orderBy: async () => {
			state.gate.markStarted();
			await state.gate.held;
			return [];
		},
	};
	return { getServiceDb: () => chain };
});

/** Heartbeat intervals the routes started and have not cleared. */
const liveIntervals = new Set<ReturnType<typeof setInterval>>();

/** Read `res` to its end; resolves once the route closes the stream. */
async function drain(res: Response): Promise<void> {
	const reader = res.body?.getReader();
	if (!reader) return;
	for (;;) {
		const { done } = await reader.read();
		if (done) return;
	}
}

/** Whether `reading` settles within a short grace period: "closed" if the route ended the stream. */
async function settled(reading: Promise<void>): Promise<"closed" | "open"> {
	const open = new Promise<"open">((resolve) => setTimeout(() => resolve("open"), 200));
	return Promise.race([reading.then((): "closed" => "closed"), open]);
}

/** Yield to the next macrotask, so every continuation queued behind the released read has run. */
function nextTask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	for (const t of [state.realtime, state.support]) {
		t.listeners.clear();
		t.unsubscribed.length = 0;
	}
	liveIntervals.clear();
	armGate();
	const realSet = globalThis.setInterval;
	const realClear = globalThis.clearInterval;
	vi.spyOn(globalThis, "setInterval").mockImplementation((...args: Parameters<typeof setInterval>) => {
		const id = realSet(...args);
		liveIntervals.add(id);
		return id;
	});
	vi.spyOn(globalThis, "clearInterval").mockImplementation((id?: Parameters<typeof clearInterval>[0]) => {
		for (const live of liveIntervals) if (live === id) liveIntervals.delete(live);
		realClear(id);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const id of liveIntervals) clearInterval(id);
});

describe("a client that disconnects during the backlog read leaves nothing running", () => {
	it("GET /api/stream/jobs/[id]: no log subscription, no heartbeat, and the stream closes", async () => {
		const { GET } = await import("@/app/api/stream/jobs/[id]/route");
		const ctl = new AbortController();
		const res = await GET(new Request("https://console.local/api/stream/jobs/job-1", { signal: ctl.signal }), {
			params: Promise.resolve({ id: "job-1" }),
		});
		expect(res.status).toBe(200);
		const reading = drain(res);
		await state.gate.started;
		ctl.abort();
		state.gate.release();
		await nextTask();
		expect(state.realtime.listeners.size).toBe(0);
		expect(liveIntervals.size).toBe(0);
		expect(await settled(reading)).toBe("closed");
	});

	it("GET /api/stream/support/cases/[id]: no thread subscription, no heartbeat, and the stream closes", async () => {
		const { GET } = await import("@/app/api/stream/support/cases/[id]/route");
		const ctl = new AbortController();
		const res = await GET(
			new Request("https://console.local/api/stream/support/cases/case-1?after=msg-0", { signal: ctl.signal }),
			{ params: Promise.resolve({ id: "case-1" }) },
		);
		expect(res.status).toBe(200);
		const reading = drain(res);
		await state.gate.started;
		ctl.abort();
		state.gate.release();
		await nextTask();
		expect(state.support.listeners.size).toBe(0);
		expect(liveIntervals.size).toBe(0);
		expect(await settled(reading)).toBe("closed");
	});
});
