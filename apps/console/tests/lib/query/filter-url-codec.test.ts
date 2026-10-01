// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The filter standard's URL codec, and the promise it exists to keep (#4980): the key a list
// ROUTE prefetches for a pasted link is the key the CLIENT asks for once `useFilterUrlSync` has
// read that link. If the two decode a param differently, the prefetch lands under a key nobody
// reads and the page falls back to the unfiltered placeholder rows — the audit's F8 failure, with
// every piece individually "working".
//
// So the agreement is asserted against the client's own path (patch the defaults with
// `filtersFromUrl`, as the hook does, then normalize), not against a hand-written expected key.

import { describe, expect, it } from "vitest";
import {
	ACTIVITY_URL_PARAMS,
	alertsQueriesFromUrl,
	CHANNEL_URL_PARAMS,
	DEFAULT_ACTIVITY_FILTERS,
	DEFAULT_CHANNEL_FILTERS,
	DEFAULT_POLICY_FILTERS,
	normalizeActivityQuery,
	normalizeChannelsQuery,
	normalizePoliciesQuery,
	POLICY_URL_PARAMS,
} from "@/components/alerts/alerts-query";
import {
	DEFAULT_RUNNER_FILTERS,
	normalizeRunnersQuery,
	runnersQueryFromUrl,
} from "@/components/runners/runners-query";
import {
	decodeFilterValue,
	encodeFilterValue,
	filterStateFromUrl,
	filtersFromUrl,
	isDefaultFilterValue,
	paramReader,
} from "@/lib/query/filter-url-codec";

describe("the codec", () => {
	it("round-trips an array through the comma encoding, and array-ness follows the default", () => {
		expect(encodeFilterValue(["a", "b"])).toBe("a,b");
		expect(decodeFilterValue("a,,b", [])).toEqual(["a", "b"]);
		expect(decodeFilterValue("a,b", "")).toBe("a,b");
	});

	it("reads an array as default regardless of order, and a string by equality", () => {
		expect(isDefaultFilterValue(["b", "a"], ["a", "b"])).toBe(true);
		expect(isDefaultFilterValue(["a"], [])).toBe(false);
		expect(isDefaultFilterValue("", "")).toBe(true);
	});

	it("returns only the params PRESENT, so a store patch leaves the rest alone", () => {
		const params = new URLSearchParams("stages=prod&unrelated=1");
		expect(filtersFromUrl(params, { search: "", stages: [] })).toEqual({ stages: ["prod"] });
	});

	it("honours a renamed param and fills the rest from the defaults", () => {
		const params = new URLSearchParams("q=api");
		expect(filterStateFromUrl(params, { search: "", stages: [] }, { search: "q" })).toEqual({
			search: "api",
			stages: [],
		});
	});

	it("reads a Next `searchParams` record, taking the first of a repeated param", () => {
		const reader = paramReader({ a: "1", b: ["2", "3"], c: undefined });
		expect(reader.get("a")).toBe("1");
		expect(reader.get("b")).toBe("2");
		expect(reader.get("c")).toBeNull();
		expect(paramReader({ e: [] }).get("e")).toBeNull();
	});
});

describe("the route's key is the key the client settles on", () => {
	it("runners: a `versions` link, in any order", () => {
		const params = new URLSearchParams("versions=1.4.0,1.10.0&search=%20prod%20");
		const client = { ...DEFAULT_RUNNER_FILTERS, ...filtersFromUrl(params, DEFAULT_RUNNER_FILTERS) };
		// The client normalizes with the DEBOUNCED search, which equals the store's once it settles.
		expect(runnersQueryFromUrl(params)).toEqual(normalizeRunnersQuery(client, client.search));
		expect(runnersQueryFromUrl(params)).toEqual({ search: "prod", versions: ["1.10.0", "1.4.0"] });
	});

	it("runners: a pristine link is `{}`, the key the route already prefetches", () => {
		expect(runnersQueryFromUrl(new URLSearchParams(""))).toEqual({});
	});

	it("alerts: each prefixed param reaches its own panel through the SAME maps the hooks use", () => {
		const params = new URLSearchParams("policyStatus=off&channelType=slack&activityStatus=failed&policy=db");
		const client = {
			policies: normalizePoliciesQuery({
				...DEFAULT_POLICY_FILTERS,
				...filtersFromUrl(params, DEFAULT_POLICY_FILTERS, POLICY_URL_PARAMS),
			}),
			channels: normalizeChannelsQuery({
				...DEFAULT_CHANNEL_FILTERS,
				...filtersFromUrl(params, DEFAULT_CHANNEL_FILTERS, CHANNEL_URL_PARAMS),
			}),
			activity: normalizeActivityQuery({
				...DEFAULT_ACTIVITY_FILTERS,
				...filtersFromUrl(params, DEFAULT_ACTIVITY_FILTERS, ACTIVITY_URL_PARAMS),
			}),
		};
		expect(alertsQueriesFromUrl(params)).toEqual(client);
		expect(alertsQueriesFromUrl(params)).toEqual({
			policies: { search: "db", status: ["off"] },
			channels: { types: ["slack"] },
			activity: { status: ["failed"] },
		});
	});
});
