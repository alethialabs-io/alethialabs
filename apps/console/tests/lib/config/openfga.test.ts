// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getOpenFgaConfig caches at module scope, so each scenario resets modules and re-imports with the
// env it wants (same pattern as lib/crypto/secrets). The next-runtime-env mock reads process.env.
const KEYS = ["OPENFGA_API_URL", "OPENFGA_STORE_ID", "OPENFGA_MODEL_ID"];
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

describe("isOpenFgaEnabled", () => {
	it("requires BOTH the api url and the store id", async () => {
		const { isOpenFgaEnabled } = await import("@/lib/config/openfga");
		expect(isOpenFgaEnabled()).toBe(false);
		process.env.OPENFGA_API_URL = "http://fga:8080";
		expect(isOpenFgaEnabled()).toBe(false); // store id still missing
		process.env.OPENFGA_STORE_ID = "store-1";
		expect(isOpenFgaEnabled()).toBe(true);
	});
});

describe("getOpenFgaConfig", () => {
	it("returns the validated config (with optional modelId) when configured", async () => {
		process.env.OPENFGA_API_URL = "http://fga:8080";
		process.env.OPENFGA_STORE_ID = "store-1";
		process.env.OPENFGA_MODEL_ID = "model-9";
		const { getOpenFgaConfig } = await import("@/lib/config/openfga");
		expect(getOpenFgaConfig()).toEqual({
			apiUrl: "http://fga:8080",
			storeId: "store-1",
			modelId: "model-9",
		});
	});

	it("throws when enabled-but-misconfigured (missing store id)", async () => {
		process.env.OPENFGA_API_URL = "http://fga:8080"; // no store id
		const { getOpenFgaConfig } = await import("@/lib/config/openfga");
		expect(() => getOpenFgaConfig()).toThrow(/Invalid OpenFGA config/);
	});
});
