// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The widget grid's placement math is pure and load-bearing (first-fit is the locked
// placement policy) — these tests pin scan order, exact fits, next-row overflow,
// collision detection, and the 5-column clamp.

import { describe, expect, it } from "vitest";
import {
	buildOccupancy,
	clampToCols,
	collides,
	firstFit,
	GRID_COLS,
	occupancyExcluding,
} from "@/lib/widgets/layout";

describe("firstFit", () => {
	it("places into the first empty cell, scanning left→right then top→down", () => {
		const occ = buildOccupancy([{ x: 0, y: 0, colspan: 2, rowspan: 1 }]);
		expect(firstFit(occ, { colspan: 1, rowspan: 1 })).toEqual({ x: 2, y: 0 });
	});

	it("fits an exact-width gap", () => {
		const occ = buildOccupancy([
			{ x: 0, y: 0, colspan: 2, rowspan: 1 },
			{ x: 4, y: 0, colspan: 1, rowspan: 1 },
		]);
		// The 2-wide hole at (2,0)…(3,0) fits exactly.
		expect(firstFit(occ, { colspan: 2, rowspan: 1 })).toEqual({ x: 2, y: 0 });
	});

	it("overflows to the next row when nothing fits the current one", () => {
		const occ = buildOccupancy([{ x: 0, y: 0, colspan: 4, rowspan: 1 }]);
		// A 2-wide widget can't fit in the single free column of row 0.
		expect(firstFit(occ, { colspan: 2, rowspan: 1 })).toEqual({ x: 0, y: 1 });
	});

	it("accounts for rowspan when checking a region", () => {
		const occ = buildOccupancy([{ x: 0, y: 1, colspan: 5, rowspan: 1 }]);
		// A 1×2 widget at row 0 would collide with the full row below it.
		expect(firstFit(occ, { colspan: 1, rowspan: 2 })).toEqual({ x: 0, y: 2 });
	});

	it("places at origin on an empty grid", () => {
		expect(firstFit(new Set(), { colspan: 3, rowspan: 2 })).toEqual({ x: 0, y: 0 });
	});
});

describe("collides", () => {
	const occ = buildOccupancy([{ x: 1, y: 1, colspan: 2, rowspan: 2 }]);

	it("detects overlap with occupied cells", () => {
		expect(collides(occ, { x: 2, y: 2, colspan: 1, rowspan: 1 })).toBe(true);
	});

	it("allows adjacency", () => {
		expect(collides(occ, { x: 3, y: 1, colspan: 1, rowspan: 1 })).toBe(false);
	});

	it("rejects anything overflowing the 5-column width or negative cells", () => {
		expect(collides(new Set(), { x: 4, y: 0, colspan: 2, rowspan: 1 })).toBe(true);
		expect(collides(new Set(), { x: -1, y: 0, colspan: 1, rowspan: 1 })).toBe(true);
	});
});

describe("clampToCols", () => {
	it("clamps span and x to the grid width", () => {
		expect(clampToCols({ x: 4, y: 0, colspan: 3, rowspan: 1 })).toEqual({
			x: 2,
			y: 0,
			colspan: 3,
			rowspan: 1,
		});
		expect(clampToCols({ x: 0, y: 0, colspan: 9, rowspan: 0 })).toEqual({
			x: 0,
			y: 0,
			colspan: GRID_COLS,
			rowspan: 1,
		});
	});
});

describe("occupancyExcluding", () => {
	it("lets a widget drop back onto its own cells", () => {
		const rects = [
			{ id: "a", x: 0, y: 0, colspan: 2, rowspan: 1 },
			{ id: "b", x: 2, y: 0, colspan: 1, rowspan: 1 },
		];
		const occ = occupancyExcluding(rects, "a");
		expect(collides(occ, { x: 0, y: 0, colspan: 2, rowspan: 1 })).toBe(false);
		expect(collides(occ, { x: 2, y: 0, colspan: 1, rowspan: 1 })).toBe(true);
	});
});
