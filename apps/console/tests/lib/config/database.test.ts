// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getDatabaseConfig caches at module scope → reset + re-import per scenario.
const KEYS = [
	"ALETHIA_DATABASE_URL",
	"ALETHIA_APP_DATABASE_URL",
	"ALETHIA_DB_POOL_MAX",
	"ALETHIA_DB_IDLE_TIMEOUT",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
	vi.resetModules();
	for (const k of KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});
afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const SERVICE = "postgres://svc:pw@localhost:5432/db";

describe("getDatabaseConfig", () => {
	it("defaults appUrl to the service URL and applies pool/idle defaults", async () => {
		process.env.ALETHIA_DATABASE_URL = SERVICE;
		const { getDatabaseConfig } = await import("@/lib/config/database");
		const cfg = getDatabaseConfig();
		expect(cfg.serviceUrl).toBe(SERVICE);
		expect(cfg.appUrl).toBe(SERVICE); // falls back to service URL
		expect(cfg.poolMax).toBe(10);
		expect(cfg.idleTimeout).toBe(20);
	});

	it("uses a distinct app URL and coerced pool settings when provided", async () => {
		process.env.ALETHIA_DATABASE_URL = SERVICE;
		process.env.ALETHIA_APP_DATABASE_URL = "postgres://app:pw@localhost:5432/db";
		process.env.ALETHIA_DB_POOL_MAX = "25";
		process.env.ALETHIA_DB_IDLE_TIMEOUT = "5";
		const { getDatabaseConfig } = await import("@/lib/config/database");
		const cfg = getDatabaseConfig();
		expect(cfg.appUrl).toBe("postgres://app:pw@localhost:5432/db");
		expect(cfg.poolMax).toBe(25); // coerced from string
		expect(cfg.idleTimeout).toBe(5);
	});

	it("throws a clear error when the service URL is missing", async () => {
		const { getDatabaseConfig } = await import("@/lib/config/database");
		expect(() => getDatabaseConfig()).toThrow(/Invalid database configuration/);
	});
});
