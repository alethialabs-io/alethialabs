// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure occupancy math for the Elench widget grid: a fixed-width (5-column) bento
// canvas that grows downward without bound. No DOM — fully unit-testable. Positions
// are 0-indexed cells; a widget occupies the rectangle [x, x+colspan) × [y, y+rowspan).

/** The grid is always 5 columns wide (rows are unbounded). */
export const GRID_COLS = 5;

/** A widget's placement rectangle on the grid (cell units). */
export interface GridRect {
	x: number;
	y: number;
	colspan: number;
	rowspan: number;
}

/** Occupancy set — one `"x,y"` key per occupied cell. */
export type Occupancy = Set<string>;

/** The cell key for (x, y). */
function cellKey(x: number, y: number): string {
	return `${x},${y}`;
}

/** Clamp a rect's span and x so it always fits the 5-column width. */
export function clampToCols(rect: GridRect): GridRect {
	const colspan = Math.min(Math.max(1, rect.colspan), GRID_COLS);
	const rowspan = Math.max(1, rect.rowspan);
	const x = Math.min(Math.max(0, rect.x), GRID_COLS - colspan);
	const y = Math.max(0, rect.y);
	return { x, y, colspan, rowspan };
}

/** Build the occupancy set for a list of placed rects. */
export function buildOccupancy(rects: GridRect[]): Occupancy {
	const occ: Occupancy = new Set();
	for (const raw of rects) {
		const r = clampToCols(raw);
		for (let y = r.y; y < r.y + r.rowspan; y++) {
			for (let x = r.x; x < r.x + r.colspan; x++) occ.add(cellKey(x, y));
		}
	}
	return occ;
}

/** Whether a rect overlaps any occupied cell (or overflows the grid width). */
export function collides(occ: Occupancy, rect: GridRect): boolean {
	if (rect.x < 0 || rect.y < 0) return true;
	if (rect.x + rect.colspan > GRID_COLS) return true;
	for (let y = rect.y; y < rect.y + rect.rowspan; y++) {
		for (let x = rect.x; x < rect.x + rect.colspan; x++) {
			if (occ.has(cellKey(x, y))) return true;
		}
	}
	return false;
}

/**
 * First-fit placement: scan rows top→down, columns left→right, and return the first
 * empty region that fits `size`. The grid grows downward without bound, so this
 * always terminates (worst case: the row below everything).
 */
export function firstFit(
	occ: Occupancy,
	size: { colspan: number; rowspan: number },
): { x: number; y: number } {
	const colspan = Math.min(Math.max(1, size.colspan), GRID_COLS);
	const rowspan = Math.max(1, size.rowspan);
	// Upper bound: one row past the lowest occupied cell always fits.
	let maxY = 0;
	for (const key of occ) {
		const y = Number(key.slice(key.indexOf(",") + 1));
		if (y + 1 > maxY) maxY = y + 1;
	}
	for (let y = 0; y <= maxY; y++) {
		for (let x = 0; x <= GRID_COLS - colspan; x++) {
			if (!collides(occ, { x, y, colspan, rowspan })) return { x, y };
		}
	}
	return { x: 0, y: maxY };
}

/** Occupancy of every rect EXCEPT the one being moved (so it can drop onto its own cells). */
export function occupancyExcluding(
	rects: Array<GridRect & { id: string }>,
	excludeId: string,
): Occupancy {
	return buildOccupancy(rects.filter((r) => r.id !== excludeId));
}
