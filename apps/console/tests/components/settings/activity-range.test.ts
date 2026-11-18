// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Activity's time window as ONE filter (#6740, the invoices fix of #6731 applied to the
// audit log). A date choice used to be `from` + `to` + `rangeLabel`: it counted 3 on "Reset · N",
// and a picked preset froze into absolute bounds under its relative name. These pin the one `range`
// value: a preset round-trips as the preset and the READ resolves it, an explicit window keeps both
// bounds, the default stays the open-ended default window, and an OLD `from`/`to` link still opens
// exactly the window it names.

import { describe, expect, it } from "vitest";
import {
	activityFiltersFromUrl,
	activityQueryFrom,
	activityQueryFromUrl,
	activityRange,
	DEFAULT_ACTIVITY_FILTERS,
} from "@/components/settings/activity/activity-filters";
import { activityTimeBounds } from "@/lib/query/activity-query";
import { CUSTOM_RANGE_LABEL, parseRangeFilter, rangeFilterLabel, rangeFromPick } from "@/lib/query/range-filter";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { presetRange } from "@repo/ui/range";

const NOW = new Date("2026-11-16T12:00:00.000Z");
/** The route's resolved default window ("Last 7 days"). */
const DEFAULT_WINDOW = { from: "2026-11-09T12:00:00.000Z", to: NOW.toISOString() };
const FALLBACK = { from: new Date(DEFAULT_WINDOW.from), to: NOW };

describe("one date choice is one filter on Reset · N (#6740)", () => {
	it("counts a preset, and an explicit window, as 1", () => {
		expect(countActiveFilters({ ...DEFAULT_ACTIVITY_FILTERS, range: "30d" }, DEFAULT_ACTIVITY_FILTERS)).toBe(1);
		const window = "2026-11-01T00:00:00.000Z/2026-11-02T00:00:00.000Z";
		expect(countActiveFilters({ ...DEFAULT_ACTIVITY_FILTERS, range: window }, DEFAULT_ACTIVITY_FILTERS)).toBe(1);
	});
});

describe("a relative preset round-trips as relative (#6740)", () => {
	it("a preset pick is stored as its id", () => {
		expect(rangeFromPick(presetRange("30d", NOW), "Last 30 days")).toBe("30d");
	});

	it("a link carrying the preset asks the read for the preset, open-ended, under its own name", () => {
		const query = activityQueryFromUrl(new URLSearchParams("range=30d"), DEFAULT_WINDOW);
		expect(query).toEqual({ within: "30d" });
		const filters = activityFiltersFromUrl(new URLSearchParams("range=30d"));
		expect(rangeFilterLabel(parseRangeFilter(filters.range), "Last 7 days")).toBe("Last 30 days");
	});

	it("the read resolves the preset against ITS clock, so a later visit sees a later window", () => {
		const dec = new Date("2026-12-16T12:00:00.000Z");
		const atNov = activityTimeBounds({ within: "30d" }, NOW);
		const atDec = activityTimeBounds({ within: "30d" }, dec);
		expect(atNov).toEqual({ from: presetRange("30d", NOW).from });
		expect(atDec.from?.getTime()).toBeGreaterThan(atNov.from?.getTime() ?? Number.POSITIVE_INFINITY);
		expect(atNov.to).toBeUndefined();
	});

	it("an explicit window keeps both bounds and is labelled as a custom range", () => {
		const range = "2026-11-01T00:00:00.000Z/2026-11-02T00:00:00.000Z";
		const filters = { ...DEFAULT_ACTIVITY_FILTERS, range };
		expect(activityQueryFrom({ filters, range: FALLBACK, search: "" })).toEqual({
			from: "2026-11-01T00:00:00.000Z",
			to: "2026-11-02T00:00:00.000Z",
		});
		expect(rangeFilterLabel(parseRangeFilter(range), "Last 7 days")).toBe(CUSTOM_RANGE_LABEL);
	});

	it("the default stays the route's open-ended default window under the default name", () => {
		expect(activityQueryFrom({ filters: DEFAULT_ACTIVITY_FILTERS, range: FALLBACK, search: "" })).toEqual({
			from: DEFAULT_WINDOW.from,
		});
		expect(activityRange(DEFAULT_ACTIVITY_FILTERS, FALLBACK)).toEqual(FALLBACK);
		expect(rangeFilterLabel(parseRangeFilter(""), "Last 7 days")).toBe("Last 7 days");
	});
});

describe("an OLD from/to link still opens exactly its window (#6740)", () => {
	const legacy = new URLSearchParams({
		from: "2026-10-01T00:00:00.000Z",
		to: "2026-10-31T00:00:00.000Z",
		rangeLabel: "Last 30 days",
	});

	it("decodes as the explicit window it names, not as the default and not as 'the last 30 days'", () => {
		expect(activityFiltersFromUrl(legacy).range).toBe("2026-10-01T00:00:00.000Z/2026-10-31T00:00:00.000Z");
		expect(activityQueryFromUrl(legacy, DEFAULT_WINDOW)).toEqual({
			from: "2026-10-01T00:00:00.000Z",
			to: "2026-10-31T00:00:00.000Z",
		});
	});

	it("a `range` param wins over retired ones, and half an old window is ignored", () => {
		legacy.set("range", "7d");
		expect(activityFiltersFromUrl(legacy).range).toBe("7d");
		expect(activityFiltersFromUrl(new URLSearchParams("from=2026-10-01T00:00:00.000Z")).range).toBe("");
	});
});
