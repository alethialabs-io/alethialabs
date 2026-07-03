// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Realtime fan-out (lib/realtime/index.ts) — Postgres LISTEN/NOTIFY pub/sub seam. We mock the
// `postgres` client at the boundary and capture the LISTEN callback per channel, then drive it
// directly to assert payload parsing, per-job dispatch, subscribe/unsubscribe bookkeeping, the
// singleton accessors, lazy connection start, and the retry-on-LISTEN-failure path.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Boundary mocks ───────────────────────────────────────────────────────────
// Each postgres() call yields a fresh client whose .listen(channel, cb) records the registration
// and returns a thenable; `state.listenReject` lets a test simulate a failed LISTEN (rejected
// promise). Hoisted so the (hoisted) vi.mock factory closes over the same state we drive here.
type Registration = { channel: string; cb: (payload?: string) => void };
const h = vi.hoisted(() => {
	const registrations: Registration[] = [];
	const state = { listenReject: null as Error | null };
	const postgresMock = vi.fn((_url: string, _opts: unknown) => ({
		listen: vi.fn((channel: string, cb: (payload?: string) => void) => {
			registrations.push({ channel, cb });
			return state.listenReject ? Promise.reject(state.listenReject) : Promise.resolve();
		}),
	}));
	return { registrations, state, postgresMock };
});
const { registrations, state, postgresMock } = h;

vi.mock("postgres", () => ({ default: h.postgresMock }));
vi.mock("@/lib/config/database", () => ({
	getDatabaseConfig: vi.fn(() => ({
		serviceUrl: "postgres://svc:secret@db:5432/alethia",
		appUrl: "postgres://app:secret@db:5432/alethia",
		poolMax: 10,
		idleTimeout: 20,
	})),
}));

import {
	getRealtimeTransport,
	getWakeTransport,
	type RealtimeTransport,
	type WakeTransport,
} from "@/lib/realtime/index";

const G = globalThis as unknown as {
	__alethiaRealtime?: RealtimeTransport;
	__alethiaWake?: WakeTransport;
};

/** Find the captured LISTEN callback for a channel (the latest registration). */
function callbackFor(channel: string): (payload?: string) => void {
	const reg = registrations.filter((r) => r.channel === channel).at(-1);
	if (!reg) throw new Error(`no LISTEN registration for ${channel}`);
	return reg.cb;
}

beforeEach(() => {
	vi.clearAllMocks();
	registrations.length = 0;
	state.listenReject = null;
	delete G.__alethiaRealtime;
	delete G.__alethiaWake;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("getRealtimeTransport — singleton + lazy start", () => {
	it("returns the same instance across calls (process-wide singleton)", () => {
		const a = getRealtimeTransport();
		const b = getRealtimeTransport();
		expect(a).toBe(b);
	});

	it("does not open a connection until the first subscribe", () => {
		getRealtimeTransport();
		expect(postgresMock).not.toHaveBeenCalled();
	});

	it("opens exactly one max:1/prepare:false LISTEN connection on first subscribe", () => {
		const rt = getRealtimeTransport();
		rt.subscribe("job-1", () => {});
		rt.subscribe("job-2", () => {});
		expect(postgresMock).toHaveBeenCalledTimes(1);
		expect(postgresMock).toHaveBeenCalledWith("postgres://svc:secret@db:5432/alethia", {
			max: 1,
			prepare: false,
		});
		expect(callbackFor("job_logs")).toBeTypeOf("function");
	});
});

describe("job_logs dispatch — payload parsing + per-job fan-out", () => {
	it("dispatches a numeric logId only to subscribers of the matching jobId", () => {
		const rt = getRealtimeTransport();
		const onJob1a = vi.fn();
		const onJob1b = vi.fn();
		const onJob2 = vi.fn();
		rt.subscribe("job-1", onJob1a);
		rt.subscribe("job-1", onJob1b);
		rt.subscribe("job-2", onJob2);

		callbackFor("job_logs")(JSON.stringify({ jobId: "job-1", logId: 42 }));

		expect(onJob1a).toHaveBeenCalledWith(42);
		expect(onJob1b).toHaveBeenCalledWith(42);
		expect(onJob2).not.toHaveBeenCalled();
	});

	it("coerces a string logId to a number", () => {
		const rt = getRealtimeTransport();
		const cb = vi.fn();
		rt.subscribe("job-x", cb);

		callbackFor("job_logs")(JSON.stringify({ jobId: "job-x", logId: "108" }));

		expect(cb).toHaveBeenCalledWith(108);
		expect(typeof cb.mock.calls[0][0]).toBe("number");
	});

	it("ignores malformed JSON payloads without throwing", () => {
		const rt = getRealtimeTransport();
		const cb = vi.fn();
		rt.subscribe("job-1", cb);

		expect(() => callbackFor("job_logs")("not-json{")).not.toThrow();
		expect(cb).not.toHaveBeenCalled();
	});

	it("ignores payloads missing jobId or logId", () => {
		const rt = getRealtimeTransport();
		const cb = vi.fn();
		rt.subscribe("job-1", cb);
		const fire = callbackFor("job_logs");

		fire(JSON.stringify({ logId: 5 })); // no jobId
		fire(JSON.stringify({ jobId: "job-1" })); // no logId
		expect(cb).not.toHaveBeenCalled();
	});

	it("does nothing for a jobId with no subscribers", () => {
		const rt = getRealtimeTransport();
		const cb = vi.fn();
		rt.subscribe("job-1", cb);

		expect(() => callbackFor("job_logs")(JSON.stringify({ jobId: "other", logId: 1 }))).not.toThrow();
		expect(cb).not.toHaveBeenCalled();
	});

	it("treats logId 0 as present (not undefined)", () => {
		const rt = getRealtimeTransport();
		const cb = vi.fn();
		rt.subscribe("job-z", cb);

		callbackFor("job_logs")(JSON.stringify({ jobId: "job-z", logId: 0 }));
		expect(cb).toHaveBeenCalledWith(0);
	});
});

describe("job_logs subscribe/unsubscribe bookkeeping", () => {
	it("unsubscribe stops delivery to the removed callback only", () => {
		const rt = getRealtimeTransport();
		const keep = vi.fn();
		const drop = vi.fn();
		rt.subscribe("job-1", keep);
		const off = rt.subscribe("job-1", drop);

		off();
		callbackFor("job_logs")(JSON.stringify({ jobId: "job-1", logId: 7 }));

		expect(keep).toHaveBeenCalledWith(7);
		expect(drop).not.toHaveBeenCalled();
	});

	it("removing the last subscriber prunes the job entry (no dispatch afterwards)", () => {
		const rt = getRealtimeTransport();
		const cb = vi.fn();
		const off = rt.subscribe("job-1", cb);
		off();
		off(); // double-unsubscribe is a safe no-op

		callbackFor("job_logs")(JSON.stringify({ jobId: "job-1", logId: 9 }));
		expect(cb).not.toHaveBeenCalled();
	});

	it("does not open a second connection across many subscribes (single LISTEN)", () => {
		const rt = getRealtimeTransport();
		rt.subscribe("a", () => {})();
		rt.subscribe("b", () => {});
		rt.subscribe("c", () => {});
		expect(postgresMock).toHaveBeenCalledTimes(1);
	});
});

describe("getRealtimeTransport — retry after a failed LISTEN", () => {
	it("re-opens the connection on the next subscribe when LISTEN rejects", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		state.listenReject = new Error("boom");

		const rt = getRealtimeTransport();
		rt.subscribe("job-1", () => {});
		expect(postgresMock).toHaveBeenCalledTimes(1);

		// Let the rejected LISTEN promise's .catch run (resets `started`).
		await Promise.resolve();
		await Promise.resolve();
		expect(errSpy).toHaveBeenCalled();

		state.listenReject = null;
		rt.subscribe("job-2", () => {});
		expect(postgresMock).toHaveBeenCalledTimes(2);
	});
});

describe("getWakeTransport — singleton, fan-out, bookkeeping", () => {
	it("returns the same instance and is separate from the realtime transport", () => {
		const a = getWakeTransport();
		const b = getWakeTransport();
		expect(a).toBe(b);
		expect(a).not.toBe(getRealtimeTransport() as unknown as WakeTransport);
	});

	it("opens its own runner_wake LISTEN on first subscribe", () => {
		const wt = getWakeTransport();
		expect(postgresMock).not.toHaveBeenCalled();
		wt.subscribe(() => {});
		expect(postgresMock).toHaveBeenCalledTimes(1);
		expect(callbackFor("runner_wake")).toBeTypeOf("function");
	});

	it("broadcasts a wake to every subscriber", () => {
		const wt = getWakeTransport();
		const a = vi.fn();
		const b = vi.fn();
		wt.subscribe(a);
		wt.subscribe(b);

		callbackFor("runner_wake")();
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
	});

	it("unsubscribe removes only that callback from the broadcast", () => {
		const wt = getWakeTransport();
		const keep = vi.fn();
		const drop = vi.fn();
		wt.subscribe(keep);
		const off = wt.subscribe(drop);

		off();
		callbackFor("runner_wake")();
		expect(keep).toHaveBeenCalledTimes(1);
		expect(drop).not.toHaveBeenCalled();
	});

	it("re-opens runner_wake on the next subscribe when LISTEN rejects", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		state.listenReject = new Error("wake-boom");

		const wt = getWakeTransport();
		wt.subscribe(() => {});
		expect(postgresMock).toHaveBeenCalledTimes(1);

		await Promise.resolve();
		await Promise.resolve();
		expect(errSpy).toHaveBeenCalled();

		state.listenReject = null;
		wt.subscribe(() => {});
		expect(postgresMock).toHaveBeenCalledTimes(2);
	});
});
