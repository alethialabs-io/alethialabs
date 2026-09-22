// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The runners surface's normalize step (#4890) — step 4 of the console filter standard
// (lib/query/README.md → "Server-side filters").
//
// What it is FOR: the output goes straight into `qk.runnersPage(org, q)`, and TanStack hashes
// that key. So two filter states a user cannot tell apart must produce one object, character for
// character — `["gcp","aws"]` and `["aws","gcp"]` are the same selection and must not be two
// cache entries that never hit. That is the whole of "unsorted arrays fragment the cache".
//
// And the pristine state must normalize to `{}`, because that is the key the runners route
// PREFETCHES. A normalize step that emitted `{search: ""}` for a pristine view would hydrate
// nothing and the grid would fetch again on mount, which is the failure the prefetch exists to
// prevent and which nothing else here would notice.

import { describe, expect, it } from "vitest";

import {
	DEFAULT_RUNNER_FILTERS,
	normalizeRunnersQuery,
	type RunnerPageFilters,
} from "@/lib/stores/use-runner-filters";

/** Filter state with every dimension set, overridable per case. */
function filters(over: Partial<RunnerPageFilters> = {}): RunnerPageFilters {
	return { ...DEFAULT_RUNNER_FILTERS, ...over };
}

describe("normalizeRunnersQuery", () => {
	it("normalizes the pristine state to {} — the key the route prefetches", () => {
		expect(normalizeRunnersQuery(DEFAULT_RUNNER_FILTERS, "")).toEqual({});
	});

	it("drops an empty selection rather than carrying an empty array", () => {
		// `{clouds: []}` and `{}` hash differently and mean the same thing.
		expect(normalizeRunnersQuery(filters({ clouds: [] }), "")).toEqual({});
	});

	it("trims the search term, and a whitespace-only search is no search", () => {
		expect(normalizeRunnersQuery(DEFAULT_RUNNER_FILTERS, "  prod  ")).toEqual({
			search: "prod",
		});
		expect(normalizeRunnersQuery(DEFAULT_RUNNER_FILTERS, "   ")).toEqual({});
	});

	it("takes the DEBOUNCED search, not the store's — the store's is per keystroke", () => {
		// The caller passes the debounced value; `filters.search` is ignored on purpose, so a
		// half-typed term can never reach the key.
		expect(normalizeRunnersQuery(filters({ search: "half-typed" }), "settled")).toEqual({
			search: "settled",
		});
	});

	it("sorts and dedupes every selection, so equivalent states share ONE key", () => {
		const a = normalizeRunnersQuery(
			filters({
				clouds: ["gcp", "aws", "gcp"],
				statuses: ["OFFLINE", "ONLINE"],
				operators: ["registered", "managed"],
				regions: ["us-east-1", "eu-central-1"],
				versions: ["1.2.0", "1.10.0"],
			}),
			"",
		);
		const b = normalizeRunnersQuery(
			filters({
				clouds: ["aws", "gcp"],
				statuses: ["ONLINE", "OFFLINE"],
				operators: ["managed", "registered"],
				regions: ["eu-central-1", "us-east-1"],
				versions: ["1.10.0", "1.2.0"],
			}),
			"",
		);
		expect(a).toEqual({
			clouds: ["aws", "gcp"],
			statuses: ["OFFLINE", "ONLINE"],
			operators: ["managed", "registered"],
			regions: ["eu-central-1", "us-east-1"],
			versions: ["1.10.0", "1.2.0"],
		});
		// The actual promise: identical JSON, which is what TanStack hashes.
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it("carries every dimension the store holds — a field it forgets never reaches the server", () => {
		const query = normalizeRunnersQuery(
			filters({
				clouds: ["aws"],
				statuses: ["ONLINE"],
				operators: ["managed"],
				regions: ["eu-central-1"],
				versions: ["1.0.0"],
			}),
			"prod",
		);
		// Derived from the store's own shape, so a new filter dimension that nobody normalizes
		// fails here rather than silently filtering nothing.
		expect(Object.keys(query).sort()).toEqual(
			Object.keys(DEFAULT_RUNNER_FILTERS).sort(),
		);
	});
});
