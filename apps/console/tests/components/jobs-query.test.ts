// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// normalizeJobsQuery is the jobs page's cache key (#578) — unsorted arrays or lingering empties
// would fragment the TanStack cache. Since #6818 it is also where three things that are NOT
// filters are kept apart from the ones that are: the project a project's list is scoped to, and the
// date range, which is now one filter value that travels in the link. The row window it used to
// carry is gone (#7483): the list pages by a keyset cursor that is never part of the key.

import { describe, expect, it } from "vitest";
import {
	DEFAULT_JOBS_FILTERS,
	jobsRangeOf,
	jobsRangeWindow,
	normalizeJobsQuery,
} from "@/components/jobs/jobs-query";
import { filterStateFromUrl } from "@/lib/query/filter-url-codec";
import { JOBS_DEFAULT_PRESET } from "@/lib/rpc/inputs/jobs";

const DEFAULT_RANGE = { preset: JOBS_DEFAULT_PRESET };

describe("normalizeJobsQuery", () => {
	it("sorts arrays and drops empty selections so equal filters produce equal keys", () => {
		const a = normalizeJobsQuery({ ...DEFAULT_JOBS_FILTERS, statuses: ["FAILED", "SUCCESS"], types: [] });
		const b = normalizeJobsQuery({ ...DEFAULT_JOBS_FILTERS, statuses: ["SUCCESS", "FAILED"] });
		expect(a).toEqual(b);
		expect(a).toEqual({ range: DEFAULT_RANGE, statuses: ["FAILED", "SUCCESS"] });
	});

	it("defaults reduce to just the default range", () => {
		expect(normalizeJobsQuery(DEFAULT_JOBS_FILTERS)).toEqual({ range: DEFAULT_RANGE });
	});

	it("trims a non-empty search and drops a blank one", () => {
		expect(normalizeJobsQuery({ ...DEFAULT_JOBS_FILTERS, search: "  prod  " })).toEqual({
			range: DEFAULT_RANGE,
			search: "prod",
		});
		expect(normalizeJobsQuery({ ...DEFAULT_JOBS_FILTERS, search: "   " })).toEqual({ range: DEFAULT_RANGE });
	});
});

describe("the project of a project's list is scope, not a filter", () => {
	it("travels as its own field and never as a `projects` filter", () => {
		const q = normalizeJobsQuery(DEFAULT_JOBS_FILTERS, "proj-1");
		expect(q).toEqual({ range: DEFAULT_RANGE, projectId: "proj-1" });
	});

	it("drops a Project selection carried over from the org list: that facet is not offered there", () => {
		const q = normalizeJobsQuery({ ...DEFAULT_JOBS_FILTERS, projects: ["other-a", "other-b"] }, "proj-1");
		expect(q.projects).toBeUndefined();
		expect(q.projectId).toBe("proj-1");
	});

	it("two projects never share a key, and neither shares the org list's", () => {
		const keys = [
			normalizeJobsQuery(DEFAULT_JOBS_FILTERS),
			normalizeJobsQuery(DEFAULT_JOBS_FILTERS, "proj-1"),
			normalizeJobsQuery(DEFAULT_JOBS_FILTERS, "proj-2"),
		].map((q) => JSON.stringify(q));
		expect(new Set(keys).size).toBe(3);
	});
});

describe("paging is not in the key", () => {
	it("carries no limit and no cursor, so the server's prefetch and every client page share one key", () => {
		const q = normalizeJobsQuery({ ...DEFAULT_JOBS_FILTERS, statuses: ["FAILED"] }, "proj-1");
		expect(Object.keys(q).sort()).toEqual(["projectId", "range", "statuses"]);
	});
});

describe("the date range is one filter value", () => {
	it("an empty value is the default preset, unresolved: the read resolves it", () => {
		expect(jobsRangeOf("")).toEqual(DEFAULT_RANGE);
	});

	it("a preset stays a preset, so its link stays relative", () => {
		expect(jobsRangeOf("30d")).toEqual({ preset: "30d" });
		expect(normalizeJobsQuery({ ...DEFAULT_JOBS_FILTERS, range: "30d" }).range).toEqual({ preset: "30d" });
	});

	it("an explicit window carries its two bounds", () => {
		expect(jobsRangeOf("2026-10-01T00:00:00.000Z/2026-10-09T00:00:00.000Z")).toEqual({
			from: "2026-10-01T00:00:00.000Z",
			to: "2026-10-09T00:00:00.000Z",
		});
	});

	it("a value that is not a range reads as the default, never as a window nobody chose", () => {
		expect(jobsRangeOf("last-tuesday")).toEqual(DEFAULT_RANGE);
	});

	it("the server and the browser build the same key from the same link", () => {
		const params = new URLSearchParams("range=14d&statuses=FAILED,SUCCESS&search=web");
		const fromLink = () => normalizeJobsQuery(filterStateFromUrl(params, DEFAULT_JOBS_FILTERS), "proj-1");
		expect(fromLink()).toEqual(fromLink());
		expect(fromLink()).toEqual({
			range: { preset: "14d" },
			search: "web",
			statuses: ["FAILED", "SUCCESS"],
			projectId: "proj-1",
		});
	});

	it("the pickers show a preset against the instant they are given, and a window as written", () => {
		const now = new Date("2026-11-20T12:00:00.000Z");
		expect(jobsRangeWindow("7d", now)).toEqual({ from: new Date("2026-11-13T12:00:00.000Z"), to: now });
		expect(jobsRangeWindow("2026-10-01T00:00:00.000Z/2026-10-09T00:00:00.000Z", now)).toEqual({
			from: new Date("2026-10-01T00:00:00.000Z"),
			to: new Date("2026-10-09T00:00:00.000Z"),
		});
		// The default window is the default preset's, not "all time".
		expect(jobsRangeWindow("", now).to).toEqual(now);
		expect(jobsRangeWindow("", now).from.getTime()).toBeLessThan(new Date("2026-01-01T00:00:00.000Z").getTime());
	});
});
