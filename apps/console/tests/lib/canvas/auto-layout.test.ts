// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { elkLayout } from "@/lib/canvas/auto-layout";

describe("elkLayout (W3 auto-layout)", () => {
	it("returns {} for an empty graph", async () => {
		expect(await elkLayout([], [])).toEqual({});
	});

	it("lays a source above its target (layered, DOWN)", async () => {
		const pos = await elkLayout(
			[
				{ id: "svc", width: 240, height: 120 },
				{ id: "db", width: 240, height: 120 },
			],
			[{ id: "svc->db", source: "svc", target: "db" }],
		);
		expect(pos.svc).toBeDefined();
		expect(pos.db).toBeDefined();
		// DOWN direction → the bound resource sits BELOW the service that consumes it.
		expect(pos.db.y).toBeGreaterThan(pos.svc.y);
	});

	it("ignores edges to unplaced nodes", async () => {
		const pos = await elkLayout(
			[{ id: "svc", width: 240, height: 120 }],
			[{ id: "svc->ghost", source: "svc", target: "ghost" }],
		);
		expect(pos.svc).toBeDefined();
		expect(pos.ghost).toBeUndefined();
	});
});
