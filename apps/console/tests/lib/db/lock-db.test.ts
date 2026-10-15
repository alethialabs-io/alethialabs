// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit: the lock pool (#6012, #6027). `withPurchaseLock` and `runWebhookEventExactlyOnce` each hold a
// transaction on a `getLockDb()` connection while the work they guard queries through `getServiceDb()`;
// if the two shared one postgres-js client, a pool's worth of purchases or webhook deliveries would
// stall it. The stall itself is reproduced against real Postgres in
// tests/integration/purchase-lock.test.ts and tests/integration/webhook-events-pool.test.ts; this pins
// the wiring: two separate clients, both on the service URL with `poolMax` connections, each built
// once. It also enforces the lock pool's one rule: only lib/billing/purchase-lock.ts and
// lib/billing/webhook-events.ts use it, so a new caller, which could hold a lock connection while
// asking for another, has to be added here by name.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
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

/** The console's root: tests/lib/db → three levels up. */
const CONSOLE_ROOT = path.resolve(__dirname, "../../..");

/** Directories under the console root that hold no console source. */
const NOT_SOURCE = new Set(["node_modules", ".next", "coverage", "tests", ".turbo"]);

/** Every .ts/.tsx/.mts/.js/.mjs file under `dir`, as a path relative to the console root. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!NOT_SOURCE.has(entry.name)) out.push(...sourceFiles(full));
		} else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
			out.push(path.relative(CONSOLE_ROOT, full));
		}
	}
	return out;
}

describe("getLockDb — the single caller", () => {
	it("is named only by lib/db/index.ts, which defines it, lib/billing/purchase-lock.ts and lib/billing/webhook-events.ts", () => {
		// Any mention counts, not just an import line: a re-export or an aliased import is a caller too.
		const naming = sourceFiles(CONSOLE_ROOT)
			.filter((file) => readFileSync(path.join(CONSOLE_ROOT, file), "utf8").includes("getLockDb"))
			.map((file) => file.split(path.sep).join("/"))
			.sort();
		expect(naming).toEqual(["lib/billing/purchase-lock.ts", "lib/billing/webhook-events.ts", "lib/db/index.ts"]);
	});
});
