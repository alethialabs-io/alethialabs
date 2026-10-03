// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Token-cloud health probe. The Hetzner fixture answers /datacenters with 410 Gone, exactly as Hetzner has
// since it removed that endpoint on 2026-10-01 — the regression that failed every Hetzner connect with
// "hetzner API returned HTTP 410". A probe that drifts back to it reads as disconnected here.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeTokenCloudHealth } from "@/lib/cloud-providers/health/tokencloud";

vi.mock("@/lib/crypto/secrets", () => ({
	decryptSecret: vi.fn(() => ({ api_token: "tok" })),
}));

const token = { v: 0, iv: "iv", tag: "tag", data: "data" };

/** The fixture Hetzner API: /datacenters is gone, every other path answers 200. */
function hcloud(url: string): Response {
	if (url.includes("/datacenters")) return new Response("{}", { status: 410 });
	return new Response(JSON.stringify({ locations: [] }), { status: 200 });
}

beforeEach(() => {
	vi.restoreAllMocks();
});

describe("probeTokenCloudHealth (hetzner)", () => {
	it("reports connected against today's API, without calling the removed /datacenters", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input: unknown) => hcloud(String(input)));

		const res = await probeTokenCloudHealth({ provider: "hetzner", credentials: { token } });

		expect(res.status).toBe("connected");
		const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
		expect(urls).toEqual(["https://api.hetzner.cloud/v1/locations"]);
	});

	it("reports a rejected token as disconnected", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response("{}", { status: 401 }),
		);

		const res = await probeTokenCloudHealth({ provider: "hetzner", credentials: { token } });

		expect(res.status).toBe("disconnected");
		expect(res.error).toContain("HTTP 401");
	});
});
