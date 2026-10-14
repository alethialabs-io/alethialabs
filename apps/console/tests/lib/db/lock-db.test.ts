// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit: the lock pool (#6012). `withPurchaseLock` holds a transaction on a `getLockDb()` connection
// while its work queries through `getServiceDb()`; if the two shared one postgres-js client, a pool's
// worth of purchases would stall it. The stall itself is reproduced against real Postgres in
// tests/integration/purchase-lock.test.ts; this pins the wiring: two separate clients, both on the
// service URL with `poolMax` connections, each built once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { postgresMock, drizzleMock } = vi.hoisted(() => ({
	postgresMock: vi.fn((url: string, opts: { max: number }) => ({ client: true, url, opts })),
	drizzleMock: vi.fn((client: unknown) => ({ db: true, client })),
}));

vi.mock("postgres", () => ({ default: postgresMock }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: drizzleMock }));
vi.mock("@/lib/config/database", () => ({
	getDatabaseConfig: () => ({
		serviceUrl: "postgres://service@db/alethia",
		appUrl: "postgres://app@db/alethia",
		poolMax: 7,
		idleTimeout: 20,
	}),
}));

import { getLockDb, getServiceDb } from "@/lib/db";

/** Drops the cached clients so each test builds its own. */
function resetClients(): void {
	globalThis.__alethiaServiceDb = undefined;
	globalThis.__alethiaLockDb = undefined;
}

describe("getLockDb", () => {
	beforeEach(() => {
		resetClients();
		postgresMock.mockClear();
		drizzleMock.mockClear();
	});
	afterEach(resetClients);

	it("is a client of its own, not the service pool", () => {
		const lock = getLockDb();
		const service = getServiceDb();
		expect(lock).not.toBe(service);
		expect(postgresMock).toHaveBeenCalledTimes(2);
	});

	it("connects as the service role with `poolMax` connections", () => {
		getLockDb();
		expect(postgresMock).toHaveBeenCalledWith("postgres://service@db/alethia", {
			max: 7,
			idle_timeout: 20,
			prepare: false,
		});
	});

	it("is built once and reused", () => {
		expect(getLockDb()).toBe(getLockDb());
		expect(postgresMock).toHaveBeenCalledTimes(1);
	});
});
