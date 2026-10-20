// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The project switcher's search ranks what the user TYPED (F038, #6114).
//
// cmdk's default scorer is fuzzy: "zz" listed htz3, htz2 and azdemo — names that contain a z and a
// z somewhere, which the user did not type and could not see a reason for. `rankProjectMatch` is the
// switcher's `filter`: exact, then prefix, then the start of a later word, then a plain substring,
// and nothing else.

import { describe, expect, it } from "vitest";
import { rankProjectMatch } from "@/components/project-switcher";

/** The names that survive `search`, best first — what the switcher lists. */
function listed(names: string[], search: string): string[] {
	return names
		.map((name) => ({ name, score: rankProjectMatch(name, search) }))
		.filter((r) => r.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((r) => r.name);
}

const PROJECTS = ["htz3", "htz2", "azdemo", "zz-top", "buzz", "shop", "my-shop", "workshop"];

describe("rankProjectMatch (F038)", () => {
	it("never returns a scattered-letter match: \"zz\" does not list htz3, htz2 or azdemo", () => {
		expect(listed(PROJECTS, "zz")).toEqual(["zz-top", "buzz"]);
	});

	it("ranks exact, then prefix, then a later word's start, then a substring", () => {
		expect(listed(["workshop", "my-shop", "shopfront", "shop"], "shop")).toEqual([
			"shop",
			"shopfront",
			"my-shop",
			"workshop",
		]);
	});

	it("is case-insensitive and ignores surrounding whitespace", () => {
		expect(rankProjectMatch("Shop", "  sHoP ")).toBe(1);
	});

	it("lists everything for an empty search", () => {
		expect(listed(PROJECTS, "")).toHaveLength(PROJECTS.length);
	});
});
