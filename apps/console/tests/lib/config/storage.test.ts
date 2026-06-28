// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getStorageConfig caches at module scope → reset + re-import per scenario. The next-runtime-env
// mock resolves from process.env.
const KEYS = [
	"ALETHIA_STORAGE_ENDPOINT",
	"ALETHIA_STORAGE_REGION",
	"ALETHIA_STORAGE_ACCESS_KEY_ID",
	"ALETHIA_STORAGE_SECRET_ACCESS_KEY",
	"ALETHIA_STORAGE_AUTO_CREATE_BUCKETS",
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

function setValidStorageEnv() {
	process.env.ALETHIA_STORAGE_ENDPOINT = "http://seaweedfs:8333";
	process.env.ALETHIA_STORAGE_ACCESS_KEY_ID = "key";
	process.env.ALETHIA_STORAGE_SECRET_ACCESS_KEY = "secret";
}

describe("getStorageConfig", () => {
	it("applies schema defaults (region us-east-1, autoCreateBuckets true)", async () => {
		setValidStorageEnv();
		const { getStorageConfig } = await import("@/lib/config/storage");
		const cfg = getStorageConfig();
		expect(cfg.region).toBe("us-east-1");
		expect(cfg.autoCreateBuckets).toBe(true);
		expect(cfg.endpoint).toBe("http://seaweedfs:8333");
	});

	it("parses the auto-create-buckets flag (off-ish strings → false)", async () => {
		setValidStorageEnv();
		process.env.ALETHIA_STORAGE_AUTO_CREATE_BUCKETS = "false";
		const { getStorageConfig } = await import("@/lib/config/storage");
		expect(getStorageConfig().autoCreateBuckets).toBe(false);
	});

	it("treats a truthy flag string as true", async () => {
		setValidStorageEnv();
		process.env.ALETHIA_STORAGE_AUTO_CREATE_BUCKETS = "yes";
		const { getStorageConfig } = await import("@/lib/config/storage");
		expect(getStorageConfig().autoCreateBuckets).toBe(true);
	});

	it("throws an actionable error when the endpoint/keys are missing", async () => {
		const { getStorageConfig } = await import("@/lib/config/storage");
		expect(() => getStorageConfig()).toThrow(/Invalid S3 storage configuration/);
	});
});
