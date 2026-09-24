// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The zero-result decision and its copy for Settings · Roles (#4968 review): "nothing matches"
// may only be read off a SETTLED query, and the count names the role universe.

import { describe, expect, it } from "vitest";
import {
	hasNoMatches,
	noMatchesDescription,
} from "@/components/settings/roles/roles-filters";

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

describe("noMatchesDescription", () => {
	it("names the universe total", () => {
		expect(noMatchesDescription(8)).toBe("None of the 8 roles match these filters.");
		expect(noMatchesDescription(1)).toBe("None of the 1 role matches these filters.");
	});

	it("leaves the number out until the universe is known", () => {
		expect(noMatchesDescription(undefined)).toBe("No roles match these filters.");
	});
});
