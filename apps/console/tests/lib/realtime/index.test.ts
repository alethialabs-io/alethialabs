// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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
type Registration = {
	channel: string;
	cb: (payload?: string) => void;
	onlisten?: () => void;
	end: ReturnType<typeof vi.fn>;
};
const h = vi.hoisted(() => {
	const registrations: Registration[] = [];
	const state = { listenReject: null as Error | null };
	const postgresMock = vi.fn((_url: string, _opts: unknown) => {
		const end = vi.fn(() => Promise.resolve());
		return {
			end,
			listen: vi.fn(
				(channel: string, cb: (payload?: string) => void, onlisten?: () => void) => {
					registrations.push({ channel, cb, onlisten, end });
					return state.listenReject ? Promise.reject(state.listenReject) : Promise.resolve();
				},
			),
		};
	});
	// A structured-logger spy: the LISTEN-failure path logs via log.child(...).error.
	const logErrorSpy = vi.fn();
	return { registrations, state, postgresMock, logErrorSpy };
});
const { registrations, state, postgresMock, logErrorSpy } = h;

vi.mock("postgres", () => ({ default: h.postgresMock }));
vi.mock("@/lib/observability/log", () => ({
	log: { child: () => ({ error: h.logErrorSpy }) },
}));
vi.mock("@/lib/config/database", () => ({
	getDatabaseConfig: vi.fn(() => ({
		serviceUrl: "postgres://svc:secret@db:5432/alethia",
		appUrl: "postgres://app:secret@db:5432/alethia",
		poolMax: 10,
		idleTimeout: 20,
	})),
}));

import {
	type ChangeTransport,
	type ChangeValue,
	getChangeTransport,
	getRealtimeTransport,
	getWakeTransport,
	type RealtimeTransport,
	type WakeTransport,
} from "@/lib/realtime/index";

const G = globalThis as unknown as {
	__alethiaRealtime?: RealtimeTransport;
	__alethiaWake?: WakeTransport;
	__alethiaChange?: ChangeTransport;
};

/** The latest LISTEN registration for a channel. */
function registrationFor(channel: string): Registration {
	const reg = registrations.filter((r) => r.channel === channel).at(-1);
	if (!reg) throw new Error(`no LISTEN registration for ${channel}`);
	return reg;
}

/** Find the captured LISTEN callback for a channel (the latest registration). */
function callbackFor(channel: string): (payload?: string) => void {
	return registrationFor(channel).cb;
}

beforeEach(() => {
	vi.clearAllMocks();
	registrations.length = 0;
	state.listenReject = null;
	delete G.__alethiaRealtime;
	delete G.__alethiaWake;
	delete G.__alethiaChange;
	delete process.env.ALETHIA_LISTEN_DATABASE_URL;
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
		state.listenReject = new Error("boom");

		const rt = getRealtimeTransport();
		rt.subscribe("job-1", () => {});
		expect(postgresMock).toHaveBeenCalledTimes(1);

		// Let the rejected LISTEN promise's .catch run (resets `started`).
		await Promise.resolve();
		await Promise.resolve();
		expect(logErrorSpy).toHaveBeenCalled();

		state.listenReject = null;
		rt.subscribe("job-2", () => {});
		expect(postgresMock).toHaveBeenCalledTimes(2);
	});

	it("closes the client whose LISTEN failed instead of leaking it", async () => {
		state.listenReject = new Error("boom");
		getRealtimeTransport().subscribe("job-1", () => {});
		const failed = registrationFor("job_logs");
		await Promise.resolve();
		await Promise.resolve();
		expect(failed.end).toHaveBeenCalledWith({ timeout: 1 });
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
		state.listenReject = new Error("wake-boom");

		const wt = getWakeTransport();
		wt.subscribe(() => {});
		expect(postgresMock).toHaveBeenCalledTimes(1);

		await Promise.resolve();
		await Promise.resolve();
		expect(logErrorSpy).toHaveBeenCalled();

		state.listenReject = null;
		wt.subscribe(() => {});
		expect(postgresMock).toHaveBeenCalledTimes(2);
	});
});

// ── #6115: the change bus's transport ─────────────────────────────────────────

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const JOB = "44444444-4444-4444-8444-444444444444";

/** A jobs notice as the trigger sends it. */
function jobsPayload(o: string, u: string): string {
	return JSON.stringify({ t: "jobs", id: JOB, o, u, p: null });
}

describe("getChangeTransport — alethia_change", () => {
	it("LISTENs on the service URL by default, on ALETHIA_LISTEN_DATABASE_URL when it is set", () => {
		getChangeTransport().tap(() => {});
		expect(postgresMock).toHaveBeenLastCalledWith("postgres://svc:secret@db:5432/alethia", {
			max: 1,
			prepare: false,
		});
		delete G.__alethiaChange;
		process.env.ALETHIA_LISTEN_DATABASE_URL = "postgres://direct:secret@db-direct:5432/alethia";
		getChangeTransport().tap(() => {});
		expect(postgresMock).toHaveBeenLastCalledWith(
			"postgres://direct:secret@db-direct:5432/alethia",
			{ max: 1, prepare: false },
		);
		expect(registrationFor("alethia_change")).toBeDefined();
	});

	it("taps every routed notice, including ones no key subscriber wants", () => {
		const seen: ChangeValue[] = [];
		getChangeTransport().tap((v) => seen.push(v));
		callbackFor("alethia_change")(jobsPayload(ORG, USER));
		callbackFor("alethia_change")(JSON.stringify({ t: "_selftest", n: "nonce" }));
		callbackFor("alethia_change")("not json");
		callbackFor("alethia_change")(JSON.stringify({ t: "nope" }));
		expect(seen.map((v) => v.kind)).toEqual(["change", "selftest"]);
	});

	it("calls a subscriber on two of a notice's keys ONCE", () => {
		const ct = getChangeTransport();
		const cb = vi.fn();
		ct.subscribe(`o:${USER}`, cb);
		ct.subscribe(`u:${USER}`, cb);
		callbackFor("alethia_change")(jobsPayload(USER, USER));
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it("fires onReconnect on every LISTEN after the first, never on the first", () => {
		const ct = getChangeTransport();
		const hook = vi.fn();
		ct.onReconnect(hook);
		ct.tap(() => {});
		const reg = registrationFor("alethia_change");
		reg.onlisten?.();
		expect(hook).not.toHaveBeenCalled();
		reg.onlisten?.(); // postgres-js re-LISTENed after a dropped connection
		expect(hook).toHaveBeenCalledTimes(1);
	});

	it("restart() closes the client, opens a new one, and its first LISTEN counts as a reconnect", () => {
		const ct = getChangeTransport();
		const hook = vi.fn();
		ct.onReconnect(hook);
		ct.tap(() => {});
		const first = registrationFor("alethia_change");
		first.onlisten?.();
		ct.restart();
		expect(first.end).toHaveBeenCalledWith({ timeout: 1 });
		expect(postgresMock).toHaveBeenCalledTimes(2);
		first.onlisten?.(); // a late LISTEN on the old client is ignored
		expect(hook).not.toHaveBeenCalled();
		registrationFor("alethia_change").onlisten?.();
		expect(hook).toHaveBeenCalledTimes(1);
	});

	it("whenListening resolves true on the first LISTEN and false on a timeout", async () => {
		vi.useFakeTimers();
		try {
			const ct = getChangeTransport();
			const waiting = ct.whenListening(5000);
			registrationFor("alethia_change").onlisten?.();
			await expect(waiting).resolves.toBe(true);
			await expect(ct.whenListening(5000)).resolves.toBe(true);
			ct.restart();
			const deaf = ct.whenListening(5000);
			vi.advanceTimersByTime(5000);
			await expect(deaf).resolves.toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
