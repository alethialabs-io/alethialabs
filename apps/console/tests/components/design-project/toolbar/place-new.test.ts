// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where a newly added card lands (#6832, #6838): where it was asked for, unless that would put it on
// or against a card already there — judged by the whole card, not by its corner.

import { describe, expect, it } from "vitest";
import {
	CARD_FOOTPRINT,
	CARD_GAP,
	cardsCollide,
	freeSpot,
} from "@/components/design-project/canvas/toolbar/place-new";

/** Every pair of cards in `cards` that overlap or sit closer than the gap, as "i-j". */
function collisions(cards: readonly { x: number; y: number }[]): string[] {
	const found: string[] = [];
	for (let i = 0; i < cards.length; i++) {
		for (let j = i + 1; j < cards.length; j++) {
			if (cardsCollide(cards[i], cards[j])) found.push(`${i}-${j}`);
		}
	}
	return found;
}

describe("cardsCollide", () => {
	it("reads two cards as colliding when their footprints overlap, not only when corners meet", () => {
		// The case the corner check missed (#7132): 40px apart, the second card covers the first.
		expect(cardsCollide({ x: 0, y: 0 }, { x: 40, y: 40 })).toBe(true);
		expect(cardsCollide({ x: 0, y: 0 }, { x: 200, y: 20 })).toBe(true);
	});

	it("keeps the gap: cards that touch edge to edge still collide", () => {
		expect(cardsCollide({ x: 0, y: 0 }, { x: CARD_FOOTPRINT.w, y: 0 })).toBe(true);
		expect(cardsCollide({ x: 0, y: 0 }, { x: CARD_FOOTPRINT.w + CARD_GAP, y: 0 })).toBe(false);
		expect(cardsCollide({ x: 0, y: 0 }, { x: 0, y: CARD_FOOTPRINT.h + CARD_GAP })).toBe(false);
	});
});

describe("freeSpot", () => {
	it("uses the wanted point on an empty board", () => {
		expect(freeSpot({ x: 100, y: 80 }, [])).toEqual({ x: 100, y: 80 });
	});

	it("leaves the wanted point alone when the cards are clear of it", () => {
		expect(freeSpot({ x: 100, y: 80 }, [{ x: 700, y: 80 }, { x: 100, y: 500 }])).toEqual({
			x: 100,
			y: 80,
		});
	});

	it("moves off a card that is near the wanted point, even when its corner is not on it", () => {
		const taken = [{ x: 0, y: 0 }];
		const spot = freeSpot({ x: 180, y: 20 }, taken);
		expect(collisions([...taken, spot])).toEqual([]);
	});

	it("puts the next card in the nearest slot to the right of a card at the wanted point", () => {
		expect(freeSpot({ x: 100, y: 80 }, [{ x: 100, y: 80 }])).toEqual({
			x: 100 + CARD_FOOTPRINT.w + CARD_GAP,
			y: 80,
		});
	});

	it("puts a run of adds at one point on the board without any two touching", () => {
		const wanted = { x: 0, y: 0 };
		const cards: { x: number; y: number }[] = [];
		for (let n = 0; n < 12; n++) cards.push(freeSpot(wanted, cards));
		expect(collisions(cards)).toEqual([]);
	});

	it("goes right of everything on a board too crowded for the rings, and still collides with nothing", () => {
		const stepX = CARD_FOOTPRINT.w + CARD_GAP;
		const stepY = CARD_FOOTPRINT.h + CARD_GAP;
		const taken: { x: number; y: number }[] = [];
		for (let j = -8; j <= 8; j++) {
			for (let i = -8; i <= 8; i++) taken.push({ x: i * stepX, y: j * stepY });
		}
		const spot = freeSpot({ x: 0, y: 0 }, taken);
		expect(spot).toEqual({ x: 9 * stepX, y: 0 });
		expect(taken.filter((p) => cardsCollide(p, spot))).toEqual([]);
	});
});
