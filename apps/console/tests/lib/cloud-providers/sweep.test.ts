// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The connection sweep must never health-probe a `pending` identity: those are dangling connect-sheet
// placeholders (initIdentity pre-creates one per provider with empty credentials). Probing them fails
// and poisons them to `disconnected` → a phantom "Verification failed" on the connectors page. We
// render the due-connections WHERE predicate to SQL and assert it excludes `status = 'pending'`.

import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/cloud-providers/health", () => ({
	hasServerSideHealth: vi.fn(() => false),
	probeHealth: vi.fn(),
}));
vi.mock("@/lib/cloud-providers/inventory", () => ({
	gcRemovedInventory: vi.fn().mockResolvedValue(0),
	hasServerSideInventory: vi.fn(() => false),
	syncCloudInventory: vi.fn(),
}));

import { runConnectionSweep } from "@/lib/cloud-providers/sweep";
import { getServiceDb } from "@/lib/db";

describe("runConnectionSweep — due-connections filter", () => {
	beforeEach(() => vi.clearAllMocks());

	it("excludes pending placeholders from the sweep", async () => {
		let wherePredicate: unknown;
		const chain: Record<string, unknown> = {};
		Object.assign(chain, {
			select: () => chain,
			from: () => chain,
			where: (pred: unknown) => {
				wherePredicate = pred;
				return chain;
			},
			// dueConnections ends in .limit(BATCH) and awaits → resolve to no due rows.
			limit: () => Promise.resolve([]),
		});
		vi.mocked(getServiceDb).mockReturnValue(chain as never);

		const result = await runConnectionSweep();
		expect(result).toEqual({ checked: 0, disconnected: 0 });

		// Render the captured predicate; it must encode a `status <> 'pending'` guard.
		const { sql, params } = new PgDialect().sqlToQuery(wherePredicate as never);
		expect(params).toContain("pending");
		expect(sql).toMatch(/<>|!=|not/i);
	});
});
