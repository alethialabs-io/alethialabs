// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6113: the server prefetch and the client must build the SAME read input for the same URL, or
// first paint misses the prefetched entry (F004). A preset travels unresolved.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { RANGE_PRESETS } from "@repo/ui/range";
import { JOBS_DEFAULT_PRESET, jobsPageInputFrom, jobsPresetForLabel } from "@/lib/rpc/inputs/jobs";
import { toJobsQuery } from "@/lib/rpc/procedures/jobs";

describe("the read input", () => {
	it("is identical when built twice from the same filters (no clock in it)", async () => {
		const a = jobsPageInputFrom({ statuses: ["FAILED"] }, { preset: JOBS_DEFAULT_PRESET });
		await new Promise((r) => setTimeout(r, 5));
		const b = jobsPageInputFrom({ statuses: ["FAILED"] }, { preset: JOBS_DEFAULT_PRESET });
		expect(a).toEqual(b);
	});

	it("omits empty filters so equal filter states are equal keys", () => {
		expect(jobsPageInputFrom({}, { preset: "7d" })).toEqual({ range: { preset: "7d" } });
	});

	it("maps a quick-range label back to its preset and a custom range to nothing", () => {
		expect(jobsPresetForLabel("Last 30 days", RANGE_PRESETS)).toEqual({ preset: "30d" });
		expect(jobsPresetForLabel("Oct 1 – Oct 9", RANGE_PRESETS)).toBeUndefined();
	});
});

describe("the server resolves the range at read time", () => {
	it("turns a preset into bounds ending at the read", () => {
		const now = new Date("2026-10-19T12:00:00.000Z");
		const q = toJobsQuery({ range: { preset: "7d" } }, now);
		expect(q.to).toBe("2026-10-19T12:00:00.000Z");
		expect(q.from).toBe("2026-10-12T12:00:00.000Z");
	});

	it("passes explicit bounds through untouched", () => {
		const q = toJobsQuery({ range: { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" }, search: "x" });
		expect(q).toEqual({ from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", search: "x" });
	});
});
