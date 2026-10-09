// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// A long-lived SSE route ties its work (a realtime subscription, a heartbeat, the runner's presence
// lease) to `req.signal`. undici's `Request` follows its caller's signal only while the `Request`
// object is reachable: it holds its own abort controller through a WeakRef, and drops the listener
// once that controller is collected (#5817, root-caused in #5796). So each test below forces a full
// GC between the start of the response and the client's disconnect, and then asserts the work
// stopped. The test never keeps the `Request` itself — it is built inline in the call — and no mock
// below records its arguments, because a `vi.fn` holding the request would keep it reachable and
// pass the test for the wrong reason.

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A channel transport the test can drive: the live listeners per key, and what unsubscribed. */
interface FakeTransport {
	listeners: Map<string, (payload: string) => void>;
	unsubscribed: string[];
}

const state = vi.hoisted(() => {
	/** A fresh fake transport. */
	const transport = (): FakeTransport => ({ listeners: new Map(), unsubscribed: [] });
	/** Every query the routes issued, by a short label. */
	const queries: string[] = [];
	/** The SQL text of every `execute` call (runner presence). */
	const executed: string[] = [];
	return { realtime: transport(), support: transport(), wake: transport(), cancel: transport(), queries, executed };
});

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
// A plain async function, not a vi.fn: a mock records its arguments, and the argument is the request.
vi.mock("@/lib/runners/auth", () => ({
	verifyRunnerToken: async () => ({ runnerId: "runner-1", tokenHash: "", operator: "", error: null }),
}));
vi.mock("@/lib/realtime", () => ({
	getRealtimeTransport: () => ({
		subscribe: (key: string, fn: (p: string) => void) => subscribeOn(state.realtime, key, fn),
	}),
	getSupportMessageTransport: () => ({
		subscribe: (key: string, fn: (p: string) => void) => subscribeOn(state.support, key, fn),
	}),
	getWakeTransport: () => ({
		subscribe: (fn: () => void) => subscribeOn(state.wake, "all", () => fn()),
	}),
	getCancelTransport: () => ({
		subscribe: (key: string, fn: (p: string) => void) => subscribeOn(state.cancel, key, fn),
	}),
}));
vi.mock("@/lib/db", () => {
	/** A drizzle-shaped chain: `.limit()` is a single-row lookup, `.orderBy()` a list read. */
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: async () => {
			state.queries.push("row");
			return [{ org_id: "org-1", user_id: "user-1", created_at: new Date(0) }];
		},
		orderBy: async () => {
			state.queries.push("list");
			return [];
		},
		execute: async (q: { queryChunks?: unknown[] }) => {
			state.executed.push(JSON.stringify(q.queryChunks ?? q));
			return [];
		},
	};
	return { getServiceDb: () => chain };
});

/**
 * Run a full garbage collection now, just before the client disconnects: a route that let its
 * `Request` go would miss the disconnect only when a collection happened to land first, and
 * collecting every time turns that race into a certain failure.
 */
function collectGarbage(): void {
	setFlagsFromString("--expose-gc");
	const gc: unknown = runInNewContext("gc");
	if (typeof gc === "function") gc();
}

/**
 * Yield to the next macrotask. V8 keeps a WeakRef's target alive until the current job's microtasks
 * have all run, so collecting in the same job that built the `Request` cannot clear it: without this
 * boundary the test passes even for a route that let its `Request` go.
 */
function nextTask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Read `res` to its end; resolves once the route closes the stream. */
async function drain(res: Response): Promise<void> {
	const reader = res.body?.getReader();
	if (!reader) return;
	for (;;) {
		const { done } = await reader.read();
		if (done) return;
	}
}

/** GET /api/stream/jobs/job-1 with `signal`; the request is never held by the caller. */
async function openJobStream(signal: AbortSignal): Promise<Response> {
	const { GET } = await import("@/app/api/stream/jobs/[id]/route");
	return GET(new Request("https://console.local/api/stream/jobs/job-1", { signal }), {
		params: Promise.resolve({ id: "job-1" }),
	});
}

/** GET /api/stream/support/cases/case-1 with `signal`; the request is never held by the caller. */
async function openSupportStream(signal: AbortSignal): Promise<Response> {
	const { GET } = await import("@/app/api/stream/support/cases/[id]/route");
	return GET(new Request("https://console.local/api/stream/support/cases/case-1", { signal }), {
		params: Promise.resolve({ id: "case-1" }),
	});
}

/** GET /api/runners/wake with `signal`; the request is never held by the caller. */
async function openWakeStream(signal: AbortSignal): Promise<Response> {
	const { GET } = await import("@/app/api/runners/wake/route");
	return GET(new Request("https://console.local/api/runners/wake", { signal }));
}

beforeEach(() => {
	for (const t of [state.realtime, state.support, state.wake, state.cancel]) {
		t.listeners.clear();
		t.unsubscribed.length = 0;
	}
	state.queries.length = 0;
	state.executed.length = 0;
});

describe("a client disconnect after a GC still stops the stream's work", () => {
	it("GET /api/stream/jobs/[id]: the log subscription ends, the stream closes, and a later notify reads nothing", async () => {
		const ctl = new AbortController();
		const res = await openJobStream(ctl.signal);
		expect(res.status).toBe(200);
		const reading = drain(res);
		await vi.waitFor(() => expect(state.realtime.listeners.has("job-1")).toBe(true));
		const notify = state.realtime.listeners.get("job-1");
		await nextTask();
		collectGarbage();
		ctl.abort();
		await vi.waitFor(() => expect(state.realtime.unsubscribed).toEqual(["job-1"]));
		await reading;
		// The log poll is over: a notify that was already in flight when the client left reads no rows.
		const before = state.queries.length;
		notify?.("");
		await nextTask();
		expect(state.queries.length).toBe(before);
	});

	it("GET /api/stream/support/cases/[id]: the thread subscription ends and the stream closes", async () => {
		const ctl = new AbortController();
		const res = await openSupportStream(ctl.signal);
		expect(res.status).toBe(200);
		const reading = drain(res);
		await vi.waitFor(() => expect(state.support.listeners.has("case-1")).toBe(true));
		await nextTask();
		collectGarbage();
		ctl.abort();
		await vi.waitFor(() => expect(state.support.unsubscribed).toEqual(["case-1"]));
		await reading;
		expect(state.support.listeners.size).toBe(0);
	});

	it("GET /api/runners/wake: the runner is marked lost at once, both fan-outs end, and the stream closes", async () => {
		const ctl = new AbortController();
		const res = await openWakeStream(ctl.signal);
		expect(res.status).toBe(200);
		const reading = drain(res);
		await vi.waitFor(() => expect(state.cancel.listeners.has("runner-1")).toBe(true));
		await nextTask();
		collectGarbage();
		ctl.abort();
		await vi.waitFor(() => expect(state.executed.some((q) => q.includes("runner_lost"))).toBe(true));
		await reading;
		expect(state.wake.unsubscribed).toEqual(["all"]);
		expect(state.cancel.unsubscribed).toEqual(["runner-1"]);
	});
});
