// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where a newly added card lands (#6832): where it was asked for, unless a card already sits there.

import { describe, expect, it } from "vitest";
import { freeSpot } from "@/components/design-project/canvas/toolbar/place-new";

describe("freeSpot", () => {
	it("uses the wanted point on an empty board", () => {
		expect(freeSpot({ x: 100, y: 80 }, [])).toEqual({ x: 100, y: 80 });
	});

	it("leaves the wanted point alone when the cards are elsewhere", () => {
		expect(freeSpot({ x: 100, y: 80 }, [{ x: 600, y: 80 }, { x: 100, y: 400 }])).toEqual({
			x: 100,
			y: 80,
		});
	});

	it("steps down and to the right of a card that is already there", () => {
		const spot = freeSpot({ x: 100, y: 80 }, [{ x: 100, y: 80 }]);
		expect(spot).toEqual({ x: 140, y: 120 });
	});

	it("puts three adds in a row at three different points", () => {
		const wanted = { x: 0, y: 0 };
		const first = freeSpot(wanted, []);
		const second = freeSpot(wanted, [first]);
		const third = freeSpot(wanted, [first, second]);
		const distinct = new Set([first, second, third].map((p) => `${p.x},${p.y}`));
		expect(distinct.size).toBe(3);
	});

	it("gives up moving on a board with a card at every step, rather than looping", () => {
		const diagonal = Array.from({ length: 200 }, (_, i) => ({ x: i * 40, y: i * 40 }));
		const spot = freeSpot({ x: 0, y: 0 }, diagonal);
		expect(Number.isFinite(spot.x)).toBe(true);
		expect(spot.x).toBe(spot.y);
	});
});
