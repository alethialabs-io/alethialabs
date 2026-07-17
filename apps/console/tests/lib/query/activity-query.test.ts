// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// normalizeActivityQuery is the activity feed's cache key (#578) — unsorted arrays or
// lingering empties would fragment the TanStack cache (the standard's normalize rule).

import { describe, expect, it } from "vitest";
import { normalizeActivityQuery } from "@/lib/query/use-activity-query";

describe("normalizeActivityQuery", () => {
	it("sorts arrays and trims the search so equal filters produce equal keys", () => {
		const a = normalizeActivityQuery({
			actorIds: ["b", "a"],
			resourceTypes: ["y", "x"],
			search: "  deploy  ",
		});
		const b = normalizeActivityQuery({
			actorIds: ["a", "b"],
			resourceTypes: ["x", "y"],
			search: "deploy",
		});
		expect(a).toEqual(b);
		expect(a.actorIds).toEqual(["a", "b"]);
		expect(a.search).toBe("deploy");
	});

	it("drops empty arrays, blank search, and null decision entirely", () => {
		const q = normalizeActivityQuery({
			actorIds: [],
			resourceIds: [],
			search: "   ",
			decision: null,
		});
		expect(q).toEqual({});
	});

	it("keeps a boolean decision and the cursorless range", () => {
		const q = normalizeActivityQuery({
			from: "2026-07-01T00:00:00Z",
			to: "2026-07-16T00:00:00Z",
			decision: false,
		});
		expect(q).toEqual({
			from: "2026-07-01T00:00:00Z",
			to: "2026-07-16T00:00:00Z",
			decision: false,
		});
		expect("cursor" in q).toBe(false);
	});
});
