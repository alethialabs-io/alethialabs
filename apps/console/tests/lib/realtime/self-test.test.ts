// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6115 (ADR 0005 §10 R7): the NOTIFY round trip that is the ONLY thing able to tell a deaf LISTEN
// from a quiet one. Each branch is driven with injected deps: heard → the bus counters; not heard,
// or never listening → the connection is rebuilt AND the tick throws (so /health can go degraded);
// a NOTIFY that cannot be sent → it throws without touching the connection.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability/log", () => ({
	log: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: h.error }) },
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/realtime/bus", () => ({ getChangeBus: vi.fn() }));
vi.mock("@/lib/realtime/index", () => ({
	CHANGE_CHANNEL: "alethia_change",
	getChangeTransport: vi.fn(),
}));

import { selfTestOnce } from "@/lib/realtime/self-test";

const STATS = { streams: 2, keys: 6, delivered: 10, filtered: 1, dropped: 0 };

function deps(over: { listening?: boolean; heard?: boolean; notifyError?: Error } = {}) {
	const bus = {
		awaitSelfTest: vi.fn(async () => over.heard ?? true),
		stats: vi.fn(() => STATS),
	};
	const transport = {
		whenListening: vi.fn(async () => over.listening ?? true),
		restart: vi.fn(),
	};
	const notify = vi.fn(async (_nonce: string) => {
		if (over.notifyError) throw over.notifyError;
	});
	return { bus, transport, notify, nonce: () => "nonce-1", timeoutMs: 5000 };
}

beforeEach(() => h.error.mockReset());

describe("selfTestOnce", () => {
	it("returns the bus counters when its own NOTIFY comes back", async () => {
		const d = deps();
		await expect(selfTestOnce(d)).resolves.toEqual(STATS);
		expect(d.bus.awaitSelfTest).toHaveBeenCalledWith("nonce-1", 5000);
		expect(d.notify).toHaveBeenCalledWith("nonce-1");
		expect(d.transport.restart).not.toHaveBeenCalled();
	});

	it("waits for the nonce BEFORE sending it, so a fast echo is not missed", async () => {
		const d = deps();
		await selfTestOnce(d);
		expect(d.bus.awaitSelfTest.mock.invocationCallOrder[0]).toBeLessThan(
			d.notify.mock.invocationCallOrder[0],
		);
	});

	it("rebuilds the connection and throws when the NOTIFY never comes back", async () => {
		const d = deps({ heard: false });
		await expect(selfTestOnce(d)).rejects.toThrow(/round trip did not complete/);
		expect(d.transport.restart).toHaveBeenCalledTimes(1);
		expect(h.error.mock.calls[0][0]).toMatch(/ALETHIA_LISTEN_DATABASE_URL/);
	});

	it("rebuilds the connection and throws when it never got to LISTEN", async () => {
		const d = deps({ listening: false });
		await expect(selfTestOnce(d)).rejects.toThrow(/LISTEN was not established/);
		expect(d.notify).not.toHaveBeenCalled();
		expect(d.transport.restart).toHaveBeenCalledTimes(1);
	});

	it("propagates a NOTIFY that could not be sent, and leaves the connection alone", async () => {
		const d = deps({ notifyError: new Error("db down") });
		await expect(selfTestOnce(d)).rejects.toThrow("db down");
		expect(d.transport.restart).not.toHaveBeenCalled();
	});
});
