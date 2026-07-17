// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// normalizeJobsQuery is the jobs page's cache key (#578) — unsorted arrays or lingering
// empties would fragment the TanStack cache, and a pinned projectId must override the
// Project facet (server-side scoping).

import { describe, expect, it } from "vitest";
import {
	DEFAULT_JOBS_FILTERS,
	normalizeJobsQuery,
} from "@/components/jobs/jobs-query";

const RANGE = { from: "2026-07-01T00:00:00.000Z", to: "2026-07-16T00:00:00.000Z" };

describe("normalizeJobsQuery", () => {
	it("sorts arrays and drops empty selections so equal filters produce equal keys", () => {
		const a = normalizeJobsQuery(
			{ ...DEFAULT_JOBS_FILTERS, statuses: ["FAILED", "SUCCESS"], types: [] },
			RANGE,
		);
		const b = normalizeJobsQuery(
			{ ...DEFAULT_JOBS_FILTERS, statuses: ["SUCCESS", "FAILED"] },
			RANGE,
		);
		expect(a).toEqual(b);
		expect(a).toEqual({ ...RANGE, statuses: ["FAILED", "SUCCESS"] });
	});

	it("a pinned projectId overrides the Project facet", () => {
		const q = normalizeJobsQuery(
			{ ...DEFAULT_JOBS_FILTERS, projects: ["other-a", "other-b"] },
			RANGE,
			"pinned",
		);
		expect(q.projects).toEqual(["pinned"]);
	});

	it("defaults reduce to just the range", () => {
		expect(normalizeJobsQuery(DEFAULT_JOBS_FILTERS, RANGE)).toEqual(RANGE);
	});

	it("trims a non-empty search and drops a blank one", () => {
		expect(
			normalizeJobsQuery({ ...DEFAULT_JOBS_FILTERS, search: "  prod  " }, RANGE),
		).toEqual({ ...RANGE, search: "prod" });
		expect(
			normalizeJobsQuery({ ...DEFAULT_JOBS_FILTERS, search: "   " }, RANGE),
		).toEqual(RANGE);
	});
});
