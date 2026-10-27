// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6115 (ADR 0005 D3, §10): `GET /{org}/~/events`. The tenancy steps copy the read router's handler,
// so they are pinned the same way (tests/lib/rpc/route.test.ts on #6113): the actor resolver is
// stubbed with each of its outcomes. The stream itself runs on a REAL ChangeBus over a fake
// transport, so what reaches the wire for a notice is asserted on the bytes, not on a mock call.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	const holder: { bus: ChangeBus | null } = { bus: null };
	return {
		currentActor: vi.fn(),
		urlScopedOrgId: vi.fn(),
		hasAccepted: vi.fn(),
		reauthorize: vi.fn(),
		capabilitiesOf: vi.fn(),
		startRealtimeBus: vi.fn(),
		holder,
	};
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability/log", () => {
	const noop = () => {};
	return { log: { child: () => ({ info: noop, warn: noop, error: noop }) } };
});
vi.mock("@/lib/authz/guard", () => ({ currentActor: h.currentActor }));
vi.mock("@/lib/authz/org-scope", () => ({ urlScopedOrgId: h.urlScopedOrgId }));
vi.mock("@/lib/billing/eligibility", () => ({ hasAcceptedCurrentDocuments: h.hasAccepted }));
vi.mock("@/lib/realtime/reauth", () => ({
	reauthorize: h.reauthorize,
	capabilitiesOf: h.capabilitiesOf,
}));
vi.mock("@/lib/realtime/self-test", () => ({ startRealtimeBus: h.startRealtimeBus }));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/realtime/index", () => ({ getChangeTransport: vi.fn() }));
vi.mock("@/lib/realtime/bus", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/realtime/bus")>();
	return { ...actual, getChangeBus: () => h.holder.bus };
});

import { GET } from "@/app/(private)/[org]/~/events/route";
import { UnauthorizedError } from "@/lib/auth/errors";
import type { Actor } from "@/lib/authz/types";
import { ForbiddenError } from "@/lib/authz/types";
import { ChangeBus, MAX_STREAMS_PER_USER } from "@/lib/realtime/bus";
import type { ChangeValue } from "@/lib/realtime/index";
import { PdpMemo } from "@/lib/realtime/pdp-memo";

const USER = "22222222-2222-4222-8222-222222222222";
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "66666666-6666-4666-8666-666666666666";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const SECRET_PROJECT = "88888888-8888-4888-8888-888888888888";
const JOB = "44444444-4444-4444-8444-444444444444";
const ACME: Actor = { credential: "session", userId: USER, orgId: ORG };

let emit: (v: ChangeValue) => void = () => {};
let bus: ChangeBus;

/** Next's `notFound()` signal, as `urlScopedOrgId` throws it for a non-member. */
function notFoundSignal(): Error {
	return Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), {
		digest: "NEXT_HTTP_ERROR_FALLBACK;404",
	});
}

/** A GET of `path`, abortable. */
function request(path: string, signal?: AbortSignal): Request {
	return new Request(`http://console.test${path}`, {
		headers: { cookie: "better-auth.session_token=abc" },
		signal,
	});
}

/** Reads the stream until `pattern` has appeared in what was read, or fails after `max` chunks. */
async function readUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	pattern: RegExp,
	max = 50,
): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	for (let i = 0; i < max; i++) {
		if (pattern.test(text)) return text;
		const { value, done } = await reader.read();
		if (done) return text;
		text += decoder.decode(value);
	}
	return text;
}

/** One jobs notice. */
function jobNotice(p: string | null, o = ORG, id = JOB): ChangeValue {
	return { kind: "change", t: "jobs", id, o, u: "77777777-7777-4777-8777-777777777777", p };
}

/** The data objects of every `hint` event in `text`. */
function hintsIn(text: string): unknown[] {
	return [...text.matchAll(/event: hint\nid: [^\n]+\ndata: (.*)\n\n/g)].map((m) => JSON.parse(m[1]));
}

/** The `id:` of every event in `text`, in order. */
function idsIn(text: string): string[] {
	return [...text.matchAll(/\nid: ([^\n]+)\n/g)].map((m) => m[1]);
}

beforeEach(() => {
	h.currentActor.mockReset().mockResolvedValue(ACME);
	h.urlScopedOrgId.mockReset().mockResolvedValue(ORG);
	h.hasAccepted.mockReset().mockResolvedValue(true);
	h.reauthorize.mockReset().mockResolvedValue({
		ok: true,
		actor: ACME,
		caps: { fleetView: false, manageSupport: false, viewAlerts: false },
	});
	h.capabilitiesOf.mockReset().mockResolvedValue({ fleetView: false, manageSupport: false, viewAlerts: false });
	h.startRealtimeBus.mockReset();
	const transport = {
		tap: (cb: (v: ChangeValue) => void) => {
			emit = cb;
			return () => {};
		},
		onReconnect: () => () => {},
	};
	bus = new ChangeBus({
		transport,
		memo: new PdpMemo({ check: async (_a, projectId) => projectId === PROJECT }),
	});
	h.holder.bus = bus;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the tenant is decided before anything streams", () => {
	it("answers a non-member exactly as an unknown org: 404", async () => {
		h.currentActor.mockRejectedValue(notFoundSignal());
		const res = await GET(request("/someone-elses-org/~/events"));
		expect(res.status).toBe(404);
		expect(bus.stats().streams).toBe(0);
	});

	it("answers no session with 401", async () => {
		h.currentActor.mockRejectedValue(new UnauthorizedError());
		expect((await GET(request("/acme/~/events"))).status).toBe(401);
	});

	it("answers a resolver that landed elsewhere with 403", async () => {
		h.currentActor.mockRejectedValue(
			new ForbiddenError("view", { type: "org", id: OTHER_ORG }, "substitution"),
		);
		expect((await GET(request("/acme/~/events"))).status).toBe(403);
	});

	it("answers an address that names no org with 404 without resolving anyone", async () => {
		for (const path of ["/docs/~/events", "/start/~/events", "/[org]/~/events"]) {
			expect((await GET(request(path))).status).toBe(404);
		}
		expect(h.currentActor).not.toHaveBeenCalled();
	});

	it("answers a path that is not the events mount with 404", async () => {
		expect((await GET(request("/acme/~/events/extra"))).status).toBe(404);
	});

	it("answers Terms not accepted with 403 before streaming", async () => {
		h.hasAccepted.mockResolvedValue(false);
		const res = await GET(request("/acme/~/events"));
		expect(res.status).toBe(403);
		expect(bus.stats().streams).toBe(0);
	});

	it("rethrows anything it does not recognise", async () => {
		h.currentActor.mockRejectedValue(new Error("db down"));
		await expect(GET(request("/acme/~/events"))).rejects.toThrow("db down");
	});
});

describe("?probe=1", () => {
	it("answers 429 with Retry-After when a new stream would be refused by the per-person cap", async () => {
		const open: AbortController[] = [];
		for (let i = 0; i < MAX_STREAMS_PER_USER; i++) {
			const ac = new AbortController();
			open.push(ac);
			await GET(request("/acme/~/events", ac.signal));
		}
		const probe = await GET(request("/acme/~/events?probe=1"));
		expect(probe.status).toBe(429);
		expect(probe.headers.get("retry-after")).toBe("30");
		open[0].abort();
		expect((await GET(request("/acme/~/events?probe=1"))).status).toBe(204);
		for (const c of open) c.abort();
	});

	it("answers 204 with no stream after the same checks pass", async () => {
		const res = await GET(request("/acme/~/events?probe=1"));
		expect(res.status).toBe(204);
		expect(res.body).toBeNull();
		expect(bus.stats().streams).toBe(0);
	});

	it("carries the refusal status a closed stream could not show", async () => {
		h.currentActor.mockRejectedValue(new UnauthorizedError());
		expect((await GET(request("/acme/~/events?probe=1"))).status).toBe(401);
	});
});

describe("the stream", () => {
	it("is an un-buffered, private event stream", async () => {
		const ac = new AbortController();
		const res = await GET(request("/acme/~/events", ac.signal));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
		expect(res.headers.get("cache-control")).toBe("private, no-cache, no-transform");
		expect(res.headers.get("x-accel-buffering")).toBe("no");
		ac.abort();
	});

	it("opens with retry: then hello {v, boot, cursor}", async () => {
		const ac = new AbortController();
		const res = await GET(request("/acme/~/events", ac.signal));
		const reader = res.body!.getReader();
		const text = await readUntil(reader, /event: hello\n.*\n\n/);
		const retry = /^retry: (\d+)\n\n/.exec(text);
		expect(retry).not.toBeNull();
		expect(Number(retry![1])).toBeGreaterThanOrEqual(3000);
		expect(Number(retry![1])).toBeLessThan(8000);
		const hello = JSON.parse(/event: hello\ndata: (.*)\n\n/.exec(text)![1]);
		expect(hello).toMatchObject({ v: 1 });
		expect(hello.cursor).toMatch(/^[A-Za-z0-9_-]{8}\.0$/);
		expect(hello.boot).toMatch(/^[0-9a-f-]{36}$/);
		ac.abort();
	});

	it("subscribes the org key and the caller's own key in the ADDRESS's org", async () => {
		const ac = new AbortController();
		await GET(request("/acme/~/events", ac.signal));
		expect(bus.stats()).toMatchObject({ streams: 1, keys: 2 });
		ac.abort();
	});

	it("moves the cursor only for events THIS stream was sent, never for notices filtered out of it", async () => {
		const ac = new AbortController();
		const res = await GET(request("/acme/~/events", ac.signal));
		const reader = res.body!.getReader();
		const hello = await readUntil(reader, /event: hello/);
		const tag = /"cursor":"([^".]+)\.0"/.exec(hello)![1];
		emit(jobNotice(SECRET_PROJECT)); // filtered out of this stream
		emit(jobNotice(null, OTHER_ORG)); // routed to another org
		emit(jobNotice(PROJECT)); // the first event this stream is sent
		const text = await readUntil(reader, /event: hint/);
		expect(idsIn(text)).toEqual([`${tag}.1`]);
		ac.abort();
	});

	it("gives every stream its own cursor, so a reconnect never matches the previous stream", async () => {
		const a = new AbortController();
		const b = new AbortController();
		const one = await readUntil((await GET(request("/acme/~/events", a.signal))).body!.getReader(), /hello/);
		const two = await readUntil((await GET(request("/acme/~/events", b.signal))).body!.getReader(), /hello/);
		const cursor = (t: string) => /"cursor":"([^"]+)"/.exec(t)![1];
		expect(cursor(one)).not.toBe(cursor(two));
		a.abort();
		b.abort();
	});

	it("refuses a person's ninth stream in this process with 429 and Retry-After", async () => {
		const open: AbortController[] = [];
		for (let i = 0; i < MAX_STREAMS_PER_USER; i++) {
			const ac = new AbortController();
			open.push(ac);
			expect((await GET(request("/acme/~/events", ac.signal))).status).toBe(200);
		}
		const refused = await GET(request("/acme/~/events"));
		expect(refused.status).toBe(429);
		expect(refused.headers.get("retry-after")).toBe("30");
		expect(bus.stats()).toMatchObject({ streams: MAX_STREAMS_PER_USER, refused: 1 });
		open[0].abort();
		const ac = new AbortController();
		expect((await GET(request("/acme/~/events", ac.signal))).status).toBe(200);
		for (const c of [...open, ac]) c.abort();
	});

	it("sends {t, id} and nothing else for a notice the reader may see", async () => {
		const ac = new AbortController();
		const res = await GET(request("/acme/~/events", ac.signal));
		const reader = res.body!.getReader();
		await readUntil(reader, /event: hello/);
		emit(jobNotice(PROJECT));
		const text = await readUntil(reader, /event: hint/);
		expect(hintsIn(text)).toEqual([{ t: "jobs", id: JOB }]);
		// The org, owner and project ids of the notice never reach the wire.
		expect(text).not.toContain(ORG);
		expect(text).not.toContain(PROJECT);
		expect(text).not.toContain("77777777");
		ac.abort();
	});

	it("withholds a notice about a project the reader cannot view (PDP filter)", async () => {
		const ac = new AbortController();
		const res = await GET(request("/acme/~/events", ac.signal));
		const reader = res.body!.getReader();
		await readUntil(reader, /event: hello/);
		emit(jobNotice(SECRET_PROJECT));
		emit(jobNotice(PROJECT)); // the control: same stream, a project it may view
		const text = await readUntil(reader, /event: hint/);
		expect(hintsIn(text)).toEqual([{ t: "jobs", id: JOB }]);
		expect(bus.stats().filtered).toBe(1);
		ac.abort();
	});

	it("never sends another org's notice", async () => {
		const ac = new AbortController();
		const res = await GET(request("/acme/~/events", ac.signal));
		const reader = res.body!.getReader();
		await readUntil(reader, /event: hello/);
		emit(jobNotice(null, OTHER_ORG));
		emit(jobNotice(null)); // the control
		const text = await readUntil(reader, /event: hint/);
		expect(hintsIn(text)).toHaveLength(1);
		expect(bus.stats().delivered).toBe(1);
		ac.abort();
	});

	it("coalesces a burst about one row into one frame", async () => {
		const ac = new AbortController();
		const res = await GET(request("/acme/~/events", ac.signal));
		const reader = res.body!.getReader();
		await readUntil(reader, /event: hello/);
		for (let i = 0; i < 50; i++) emit(jobNotice(null));
		const text = await readUntil(reader, /event: hint/);
		expect(hintsIn(text)).toHaveLength(1);
		ac.abort();
	});

	it("leaves the bus when the client disconnects (the leak counter returns to 0)", async () => {
		const ac = new AbortController();
		await GET(request("/acme/~/events", ac.signal));
		expect(bus.stats().streams).toBe(1);
		ac.abort();
		expect(bus.stats()).toMatchObject({ streams: 0, keys: 0 });
	});

	it("leaves the bus when the body is cancelled", async () => {
		const res = await GET(request("/acme/~/events"));
		await res.body!.cancel();
		expect(bus.stats().streams).toBe(0);
	});

	it("never subscribes a client that was gone before the stream started", async () => {
		const ac = new AbortController();
		ac.abort();
		await GET(request("/acme/~/events", ac.signal));
		expect(bus.stats().streams).toBe(0);
	});

	it("drops hints a stalled client is not reading, then resyncs once it reads again", async () => {
		const ac = new AbortController();
		const res = await GET(request("/acme/~/events", ac.signal));
		const ids = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
		// ~1,000 distinct rows: one frame of ~100 KB fills the 64 KB queue the client is not reading.
		for (let i = 0; i < 1000; i++) emit(jobNotice(null, ORG, ids(i)));
		await Promise.resolve();
		emit(jobNotice(null, ORG, ids(5000)));
		await Promise.resolve();
		expect(bus.stats().dropped).toBe(1);
		const reader = res.body!.getReader();
		await readUntil(reader, new RegExp(ids(999)));
		emit(jobNotice(null, ORG, ids(6000)));
		const text = await readUntil(reader, /event: resync/);
		expect(text).toMatch(/event: resync\nid: [^\n]+\ndata: \{"reason":"backpressure"\}/);
		ac.abort();
	});
});

describe("re-authorisation every 60 s", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	});

	it("re-checks from the snapshot of the ADDRESS's org and the cookie, on the third heartbeat", async () => {
		const ac = new AbortController();
		await GET(request("/acme/~/events", ac.signal));
		vi.advanceTimersByTime(40_000);
		expect(h.reauthorize).not.toHaveBeenCalled();
		vi.advanceTimersByTime(20_000);
		expect(h.reauthorize).toHaveBeenCalledWith({
			userId: USER,
			addressOrgId: ORG,
			cookie: "better-auth.session_token=abc",
		});
		ac.abort();
	});

	it("sends revoked and ends the stream when the member was removed mid-stream", async () => {
		h.reauthorize.mockResolvedValue({ ok: false, reason: "not-member" });
		const res = await GET(request("/acme/~/events"));
		const reader = res.body!.getReader();
		await readUntil(reader, /event: hello/);
		vi.advanceTimersByTime(60_000);
		const text = await readUntil(reader, /event: revoked/);
		expect(text).toContain('event: revoked\ndata: {"reason":"not-member"}');
		expect((await reader.read()).done).toBe(true);
		expect(bus.stats().streams).toBe(0);
	});

	it("ends the stream WITHOUT revoked when the re-check itself fails", async () => {
		h.reauthorize.mockRejectedValue(new Error("db down"));
		const res = await GET(request("/acme/~/events"));
		const reader = res.body!.getReader();
		await readUntil(reader, /event: hello/);
		vi.advanceTimersByTime(60_000);
		const text = await readUntil(reader, /never/);
		expect(text).not.toContain("revoked");
		expect(bus.stats().streams).toBe(0);
	});

	it("re-routes by the refreshed capabilities after a successful re-check", async () => {
		h.reauthorize.mockResolvedValue({
			ok: true,
			actor: ACME,
			caps: { fleetView: true, manageSupport: false, viewAlerts: false },
		});
		const ac = new AbortController();
		const res = await GET(request("/acme/~/events", ac.signal));
		const reader = res.body!.getReader();
		await readUntil(reader, /event: hello/);
		vi.advanceTimersByTime(60_000);
		const text = await readUntil(reader, /event: resync/);
		expect(text).toContain('"reason":"keys-changed"');
		expect(bus.stats().keys).toBe(3); // + platform
		ac.abort();
	});

	it("ends the stream WITHOUT revoked when the re-check does not answer in time", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		h.reauthorize.mockImplementation(() => new Promise(() => {}));
		const res = await GET(request("/acme/~/events"));
		const reader = res.body!.getReader();
		await readUntil(reader, /event: hello/);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(bus.stats().streams).toBe(1); // still waiting inside its 10 s budget
		await vi.advanceTimersByTimeAsync(10_000);
		const text = await readUntil(reader, /never/); // reads to the end of the stream
		expect(text).not.toContain("revoked"); // `revoked` is terminal; a slow re-check is not
		expect((await reader.read()).done).toBe(true);
		expect(bus.stats().streams).toBe(0);
	});

	it("uses the personal scope's own id for `~`", async () => {
		h.currentActor.mockResolvedValue({ userId: USER, orgId: USER });
		h.urlScopedOrgId.mockResolvedValue(USER);
		const ac = new AbortController();
		await GET(request("/~/~/events", ac.signal));
		vi.advanceTimersByTime(60_000);
		expect(h.reauthorize).toHaveBeenCalledWith(
			expect.objectContaining({ addressOrgId: USER }),
		);
		ac.abort();
	});
});
