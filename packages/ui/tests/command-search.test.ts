// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shared command-search ranker ranks what the user TYPED (F038, #6114; shared since #6145).
//
// cmdk's default scorer was fuzzy: "zz" listed htz3, htz2 and azdemo in the project switcher, names
// that contain a z and a z somewhere, which the user did not type and could not see a reason for.
// The project switcher's own `rankProjectMatch` fixed that for one list; this is the same ranking,
// moved into @repo/ui so every palette, switcher and picker ranks the same way: exact, then prefix,
// then the start of a later word, then a plain substring, and nothing else.

import { describe, expect, it } from "vitest";

import { groupResults, rankItems, rankMatch } from "../src/command-search";

/** The names that survive `search`, best first: what a list shows. */
const listed = (names: string[], search: string): string[] =>
	rankItems(names, search, (name) => name);

const PROJECTS = ["htz3", "htz2", "azdemo", "zz-top", "buzz", "shop", "my-shop", "workshop"];

describe("rankMatch / rankItems (F038)", () => {
	it('never returns a scattered-letter match: "zz" does not list htz3, htz2 or azdemo', () => {
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
		expect(rankMatch("Shop", "  sHoP ")).toBe(1);
	});

	it("lists everything, in input order, for an empty search", () => {
		expect(listed(PROJECTS, "")).toEqual(PROJECTS);
		expect(listed(PROJECTS, "   ")).toEqual(PROJECTS);
	});

	it("keeps input order among rows with the same score", () => {
		expect(listed(["b-shop", "a-shop", "c-shop"], "shop")).toEqual([
			"b-shop",
			"a-shop",
			"c-shop",
		]);
	});

	it("ranks a disabled row after every enabled one, whatever its score", () => {
		const off = (name: string) => name === "shop";
		expect(rankItems(["workshop", "shop", "shopfront"], "shop", (n) => n, off)).toEqual([
			"shopfront",
			"workshop",
			"shop",
		]);
	});

	it("keeps input order AND group order on an empty search, disabled rows included", () => {
		// The node palette's shape: "Compute" holds one row, a singleton already on the canvas.
		const rows = [
			{ g: "Workloads", name: "service", off: false },
			{ g: "Compute", name: "cluster", off: true },
			{ g: "Data", name: "database", off: false },
			{ g: "Data", name: "cache", off: true },
			{ g: "Data", name: "queue", off: false },
		];
		const ranked = rankItems(rows, "", (r) => r.name, (r) => r.off);
		expect(ranked).toEqual(rows);
		expect(groupResults(ranked, (r) => r.g).map((g) => g.group)).toEqual([
			"Workloads",
			"Compute",
			"Data",
		]);
	});

	it("matches the item's search text, not anything else about it", () => {
		const rows = [
			{ id: "add-database", text: "Add Database postgres rds" },
			{ id: "fit-view", text: "Fit view fit-view" },
		];
		expect(rankItems(rows, "postgres", (r) => r.text).map((r) => r.id)).toEqual([
			"add-database",
		]);
	});
});

describe("groupResults", () => {
	it("orders groups by their best row and keeps each group's rank order", () => {
		const rows = [
			{ g: "Pages", name: "workshop" },
			{ g: "Projects", name: "shop" },
			{ g: "Pages", name: "shopfront" },
		];
		const ranked = rankItems(rows, "shop", (r) => r.name);
		expect(groupResults(ranked, (r) => r.g)).toEqual([
			{ group: "Projects", items: [{ g: "Projects", name: "shop" }] },
			{
				group: "Pages",
				items: [
					{ g: "Pages", name: "shopfront" },
					{ g: "Pages", name: "workshop" },
				],
			},
		]);
	});

	it("drops a group with no matching row", () => {
		const rows = [
			{ g: "Pages", name: "billing" },
			{ g: "Jobs", name: "deploy" },
		];
		const ranked = rankItems(rows, "bill", (r) => r.name);
		expect(groupResults(ranked, (r) => r.g).map((g) => g.group)).toEqual(["Pages"]);
	});
});
