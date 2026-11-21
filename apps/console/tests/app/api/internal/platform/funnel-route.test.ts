// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The funnel route (REL-L12, #6913) reads across every tenant, so its gate is the whole of its
// authorization: unset secret → 503, wrong or missing bearer → 401, and in neither case is the
// query run. A bad `?days=` is refused with the reason; a good one reaches the query.

import { afterEach, describe, expect, it, vi } from "vitest";

const queryFunnel = vi.fn().mockResolvedValue({
	from: "2026-11-21",
	to: "2026-11-21",
	days: ["2026-11-21"],
	cells: [],
	totals: [],
});
vi.mock("@/lib/queries/funnel", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/queries/funnel")>();
	return { ...real, queryFunnel: (...args: unknown[]) => queryFunnel(...args) };
});
vi.mock("@/lib/db", () => ({ getServiceDb: () => ({}) }));

import { GET } from "@/app/api/internal/platform/funnel/route";

const original = process.env.PLATFORM_PROVISION_SECRET;
afterEach(() => {
	process.env.PLATFORM_PROVISION_SECRET = original;
	vi.clearAllMocks();
});

/** A funnel request with the given query string and bearer. */
function get(search: string, bearer?: string): Request {
	return new Request(`http://localhost/api/internal/platform/funnel${search}`, {
		headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
	});
}

describe("GET /api/internal/platform/funnel", () => {
	it("503s when the provisioning secret is unset, and runs no query", async () => {
		delete process.env.PLATFORM_PROVISION_SECRET;
		const res = await GET(get("", "anything"));
		expect(res.status).toBe(503);
		expect(queryFunnel).not.toHaveBeenCalled();
	});

	it("401s on a wrong or missing bearer, and runs no query", async () => {
		process.env.PLATFORM_PROVISION_SECRET = "s3cret";
		expect((await GET(get("", "wrong"))).status).toBe(401);
		expect((await GET(get(""))).status).toBe(401);
		expect(queryFunnel).not.toHaveBeenCalled();
	});

	it("refuses a window outside 1..90 days with the reason", async () => {
		process.env.PLATFORM_PROVISION_SECRET = "s3cret";
		for (const bad of ["?days=0", "?days=91", "?days=abc", "?days=7.5"]) {
			const res = await GET(get(bad, "s3cret"));
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "days must be a whole number from 1 to 90" });
		}
		expect(queryFunnel).not.toHaveBeenCalled();
	});

	it("answers the report for the requested window, defaulting to 30 days, uncached", async () => {
		process.env.PLATFORM_PROVISION_SECRET = "s3cret";
		const res = await GET(get("?days=7", "s3cret"));
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(queryFunnel).toHaveBeenLastCalledWith(expect.anything(), { days: 7 });
		expect((await res.json()).days).toEqual(["2026-11-21"]);

		await GET(get("", "s3cret"));
		expect(queryFunnel).toHaveBeenLastCalledWith(expect.anything(), { days: 30 });
	});
});
