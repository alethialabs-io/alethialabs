// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The zero-result decision and its copy for Settings · Roles (#4968 review): "nothing matches"
// may only be read off a SETTLED query. The copy carries no count since LST-8 (#7490): the console
// carries no list totals.

import { describe, expect, it } from "vitest";
import { hasNoMatches, rolesQueryFromUrl } from "@/components/settings/roles/roles-filters";

describe("hasNoMatches", () => {
	const base = { activeFilters: 1, builtinCount: 0, customCount: 0, settled: true };

	it("is true when filters are active, the query has settled and nothing was kept", () => {
		expect(hasNoMatches(base)).toBe(true);
	});

	it("is false while the query has not settled, whatever the counts say", () => {
		expect(hasNoMatches({ ...base, settled: false })).toBe(false);
	});

	it("is false with no active filters, or when either bucket kept a row", () => {
		expect(hasNoMatches({ ...base, activeFilters: 0 })).toBe(false);
		expect(hasNoMatches({ ...base, builtinCount: 1 })).toBe(false);
		expect(hasNoMatches({ ...base, customCount: 1 })).toBe(false);
	});
});

describe("rolesQueryFromUrl", () => {
	it("is the key the rail settles on: trimmed search and sorted kinds, empties dropped", () => {
		const params = new URLSearchParams({ search: "  aud ", kinds: "custom,builtin" });
		expect(rolesQueryFromUrl({ get: (k) => params.get(k) })).toEqual({
			search: "aud",
			kinds: ["builtin", "custom"],
		});
		expect(rolesQueryFromUrl({ get: () => null })).toEqual({});
	});
});
