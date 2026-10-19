// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6113 (ADR 0005 stress test R1): oRPC keys carry no tenant, so the browser keeps one QueryClient
// per org. Same procedure + same input in two orgs must land in two caches.

import { describe, expect, it } from "vitest";
import { getQueryClient } from "@/lib/query/client";
import { rpcUrl } from "@/lib/rpc/client";

describe("one browser cache per tenant", () => {
	it("gives each org its own client and reuses it within the org", () => {
		const acme = getQueryClient("acme");
		expect(getQueryClient("acme")).toBe(acme);
		expect(getQueryClient("globex")).not.toBe(acme);
	});

	it("never serves one org's cached entry under another org's address", () => {
		const key = [["jobs", "page"], { input: { range: { preset: "7d" } }, type: "query" }];
		getQueryClient("acme").setQueryData(key, { rows: ["acme-row"] });
		expect(getQueryClient("globex").getQueryData(key)).toBeUndefined();
		expect(getQueryClient("acme").getQueryData(key)).toEqual({ rows: ["acme-row"] });
	});
});

describe("reads go to the org the browser is on", () => {
	it.each([
		["/acme/~/jobs", "https://console.test/acme/~/rpc"],
		["/acme/web/architecture", "https://console.test/acme/~/rpc"],
		["/~/~/jobs", "https://console.test/~/~/rpc"],
		["/", "https://console.test/~/~/rpc"],
	])("%s → %s", (pathname, url) => {
		expect(rpcUrl(pathname, "https://console.test")).toBe(url);
	});
});
