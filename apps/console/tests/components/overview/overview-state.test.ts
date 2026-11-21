// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The overview grid's state in the address (#6817). The route and the browser both build the
// grid's read from these functions, so they must agree, and a hand-edited address must narrow the
// grid rather than fail its read.

import { describe, expect, it } from "vitest";
import {
	isFiltered,
	overviewProjectsInput,
	overviewSearch,
	toOverviewState,
} from "@/components/overview/overview-state";

describe("toOverviewState", () => {
	it("an address with nothing in it is the pristine grid", () => {
		expect(toOverviewState({})).toEqual({ q: "", clouds: [], repos: [], sort: "activity", view: "card" });
	});

	it("reads the search, the comma-separated filters, the sort and the view", () => {
		expect(
			toOverviewState({ q: "shop", cloud: "aws, gcp", repo: "https://example.test/a/b", sort: "name", view: "table" }),
		).toEqual({
			q: "shop",
			clouds: ["aws", "gcp"],
			repos: ["https://example.test/a/b"],
			sort: "name",
			view: "table",
		});
	});

	it("an unknown sort or view takes the default", () => {
		const state = toOverviewState({ sort: "cost", view: "kanban" });
		expect(state.sort).toBe("activity");
		expect(state.view).toBe("card");
	});

	it("cuts a hand-edited address to the read's bounds, so the read is never refused for its shape", () => {
		const state = toOverviewState({
			q: "x".repeat(500),
			cloud: ["aws", "y".repeat(65), ...Array.from({ length: 40 }, (_, i) => `c${i}`)].join(","),
			repo: ["z".repeat(2049), "ok"].join(","),
		});
		expect(state.q).toHaveLength(200);
		expect(state.clouds).toHaveLength(32);
		expect(state.clouds).not.toContain("y".repeat(65));
		expect(state.repos).toEqual(["ok"]);
	});
});

describe("overviewSearch", () => {
	it("writes nothing for the pristine grid, so the address stays `/{org}`", () => {
		expect(overviewSearch(toOverviewState({}))).toBe("");
	});

	it("round-trips a state through the address", () => {
		const state = toOverviewState({ q: "shop", cloud: "aws,gcp", repo: "r1", sort: "name", view: "table" });
		const params = new URLSearchParams(overviewSearch(state));
		expect(
			toOverviewState({
				q: params.get("q") ?? undefined,
				cloud: params.get("cloud") ?? undefined,
				repo: params.get("repo") ?? undefined,
				sort: params.get("sort") ?? undefined,
				view: params.get("view") ?? undefined,
			}),
		).toEqual(state);
	});
});

describe("overviewProjectsInput", () => {
	it("is the state without the view: switching cards and table is not a new read", () => {
		const cards = toOverviewState({ q: "shop", view: "card" });
		const table = toOverviewState({ q: "shop", view: "table" });
		expect(overviewProjectsInput(cards)).toEqual(overviewProjectsInput(table));
		expect(overviewProjectsInput(cards)).toEqual({ q: "shop", clouds: [], repos: [], sort: "activity" });
	});
});

describe("isFiltered", () => {
	it("a search or a filter narrows the grid; the sort and the view do not", () => {
		expect(isFiltered(toOverviewState({ sort: "name", view: "table" }))).toBe(false);
		expect(isFiltered(toOverviewState({ q: "shop" }))).toBe(true);
		expect(isFiltered(toOverviewState({ cloud: "aws" }))).toBe(true);
		expect(isFiltered(toOverviewState({ repo: "r1" }))).toBe(true);
	});
});
