// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";

/** Re-imports lib/assets so ASSETS_URL is read again under the current environment. */
async function load() {
	vi.resetModules();
	return import("../lib/assets");
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("assetUrl", () => {
	it("defaults to assets.alethialabs.io", async () => {
		vi.stubEnv("NEXT_PUBLIC_ASSETS_URL", undefined);
		const { assetUrl } = await load();
		expect(assetUrl("media/films/home-v1.mp4")).toBe("https://assets.alethialabs.io/media/films/home-v1.mp4");
	});

	it("joins a key with or without a leading slash to the same URL", async () => {
		vi.stubEnv("NEXT_PUBLIC_ASSETS_URL", undefined);
		const { assetUrl } = await load();
		expect(assetUrl("/people/founder-v1.jpg")).toBe(assetUrl("people/founder-v1.jpg"));
	});

	it("honours NEXT_PUBLIC_ASSETS_URL and drops its trailing slash", async () => {
		vi.stubEnv("NEXT_PUBLIC_ASSETS_URL", "https://cdn.example.test/");
		const { assetUrl } = await load();
		expect(assetUrl("/brand/mark-v1.svg")).toBe("https://cdn.example.test/brand/mark-v1.svg");
	});
});
