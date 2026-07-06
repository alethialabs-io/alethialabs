// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { __test } from "@/lib/connectors/verify";

const { timedFetch, ALLOWED_HOSTS } = __test;

describe("connector verify SSRF guard", () => {
	it("allows only https + allowlisted hosts (fixed SaaS + Datadog sites)", () => {
		expect(ALLOWED_HOSTS.has("api.cloudflare.com")).toBe(true);
		expect(ALLOWED_HOSTS.has("hub.docker.com")).toBe(true);
		expect(ALLOWED_HOSTS.has("api.datadoghq.com")).toBe(true);
		expect(ALLOWED_HOSTS.has("api.datadoghq.eu")).toBe(true);
	});

	it("rejects internal / metadata / arbitrary hosts before any fetch", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const blocked = [
			"http://169.254.169.254/latest/meta-data/",
			"https://169.254.169.254/",
			"http://localhost:6379/",
			"https://evil.com/api/cloudflare.com",
			"https://api.cloudflare.com.evil.com/",
			"http://api.cloudflare.com/", // http, not https
		];
		for (const url of blocked) {
			await expect(timedFetch(url)).rejects.toThrow();
		}
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});
});
