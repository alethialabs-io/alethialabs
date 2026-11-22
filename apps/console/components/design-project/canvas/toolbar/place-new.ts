// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where a newly added card lands (#6832, #6838).
//
// A card is added where the person is looking — the middle of what the board shows, or the point
// they opened the menu at — unless that would put it on top of a card that is already there.
//
// The first version of this compared CORNERS: a spot was free when no card's top-left corner was
// within 32px of it. A card is 248px wide, so a second card 40px to the right of the first still
// covered almost all of it, and the first browser run of the connection journeys (#7132) showed
// what that costs: the new card sat over the old card's connection handle, and a press meant for
// the handle grabbed and moved the new card instead. A spot is now free only when the new card's
// whole FOOTPRINT, plus a gap, touches no other card's footprint.
//
// The search walks outward from the wanted point in card-sized steps, ring by ring, so the card
// lands in the nearest free slot: beside the cards in view, never under one. On a board too crowded
// for the rings, it goes to the right of everything, which is free by construction.

import type { XYPosition } from "@xyflow/react";

/** A card's footprint on the board. The width is the card's own; the height covers the full tier. */
export const CARD_FOOTPRINT = { w: 248, h: 160 } as const;

/** The space kept clear between two cards, on both axes. */
export const CARD_GAP = 32;

/** How many rings of slots around the wanted point are tried before going right of everything. */
const MAX_RINGS = 6;

/** True when a card at `a` and a card at `b` would overlap or sit closer than the gap. */
export function cardsCollide(a: XYPosition, b: XYPosition): boolean {
	return (
		Math.abs(a.x - b.x) < CARD_FOOTPRINT.w + CARD_GAP &&
		Math.abs(a.y - b.y) < CARD_FOOTPRINT.h + CARD_GAP
	);
}

/**
 * The slot offsets of ring `r` (in slots, not pixels), nearest first: a slot that needs fewer steps
 * comes first, then right before left, then below before above, so a run of adds fills in to the
 * right and down from where the person is looking.
 */
function ring(r: number): Array<{ i: number; j: number }> {
	const slots: Array<{ i: number; j: number }> = [];
	for (let j = -r; j <= r; j++) {
		for (let i = -r; i <= r; i++) {
			if (Math.max(Math.abs(i), Math.abs(j)) === r) slots.push({ i, j });
		}
	}
	return slots.sort(
		(a, b) =>
			Math.abs(a.i) + Math.abs(a.j) - (Math.abs(b.i) + Math.abs(b.j)) ||
			Number(a.i < 0) - Number(b.i < 0) ||
			Number(a.j < 0) - Number(b.j < 0) ||
			Math.abs(a.j) - Math.abs(b.j),
	);
}

/**
 * `wanted`, or the nearest slot around it where a new card collides with no card of `taken`.
 * `taken` holds the top-left corners of the cards already on the board. Pure: the same inputs give
 * the same point, and the point returned never collides with any card of `taken`.
 */
export function freeSpot(wanted: XYPosition, taken: readonly XYPosition[]): XYPosition {
	const free = (spot: XYPosition) => !taken.some((p) => cardsCollide(p, spot));
	const stepX = CARD_FOOTPRINT.w + CARD_GAP;
	const stepY = CARD_FOOTPRINT.h + CARD_GAP;
	for (let r = 0; r <= MAX_RINGS; r++) {
		for (const { i, j } of ring(r)) {
			const spot = { x: wanted.x + i * stepX, y: wanted.y + j * stepY };
			if (free(spot)) return spot;
		}
	}
	// Every slot near the wanted point is taken: right of the rightmost card is always free.
	const rightmost = Math.max(...taken.map((p) => p.x));
	return { x: rightmost + stepX, y: wanted.y };
}
