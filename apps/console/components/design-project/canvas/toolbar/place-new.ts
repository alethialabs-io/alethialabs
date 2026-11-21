// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where a newly added card lands (#6832).
//
// A card is added where the person is looking — the middle of what the board shows, or the point
// they opened the menu at. Two adds in a row asked for the same point, so the second card was drawn
// exactly over the first and the board looked as if nothing had been added. `freeSpot` steps the
// wanted point down and to the right until no card already sits there.

import type { XYPosition } from "@xyflow/react";

/** How far each step moves, on both axes. Enough for the card below to show its header. */
const STEP = 40;

/** Two cards whose corners are closer than this on both axes count as one on top of the other. */
const REACH = 32;

/** The most steps taken before the point is used as it is: a board cannot be that crowded. */
const MAX_STEPS = 24;

/**
 * `wanted`, or the nearest point down and to the right of it where no card of `taken` has its
 * corner within reach. Pure: the same inputs give the same point.
 */
export function freeSpot(wanted: XYPosition, taken: readonly XYPosition[]): XYPosition {
	let spot = wanted;
	for (let step = 0; step < MAX_STEPS; step++) {
		const at = spot;
		const occupied = taken.some(
			(p) => Math.abs(p.x - at.x) < REACH && Math.abs(p.y - at.y) < REACH,
		);
		if (!occupied) return spot;
		spot = { x: spot.x + STEP, y: spot.y + STEP };
	}
	return spot;
}
