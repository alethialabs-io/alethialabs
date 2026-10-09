// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The drafts retention sweep's paging (lib/elench/drafts-sweep.ts). The SQL itself — what is
// deleted, what is settled, what a `sending` row is spared — runs against real Postgres in
// tests/integration/elench-drafts-sweep.test.ts; this file pins the bound a run may not exceed.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({}));
vi.mock("@/lib/elench/draft-claims", () => ({ settleIfSilent: vi.fn() }));

import {
	DISCARDED_RETENTION_HOURS,
	DRAFT_RETENTION_DAYS,
	drainPages,
} from "@/lib/elench/drafts-sweep";

/** A page source that hands back `sizes` in order, then zeros; counts its calls. */
function pages(sizes: number[]): { page: () => Promise<number>; calls: () => number } {
	let i = 0;
	return {
		page: async () => sizes[i++] ?? 0,
		calls: () => i,
	};
}

describe("drainPages", () => {
	it("stops at the first page shorter than pageSize", async () => {
		const p = pages([3, 3, 1, 3]);
		expect(await drainPages(p.page, { pageSize: 3, maxPages: 10 })).toBe(7);
		expect(p.calls()).toBe(3);
	});

	it("never runs more than maxPages pages, however full they are", async () => {
		const p = pages([3, 3, 3, 3, 3]);
		expect(await drainPages(p.page, { pageSize: 3, maxPages: 2 })).toBe(6);
		expect(p.calls()).toBe(2);
	});

	it("runs one page and stops when nothing is due", async () => {
		const p = pages([]);
		expect(await drainPages(p.page, { pageSize: 500, maxPages: 20 })).toBe(0);
		expect(p.calls()).toBe(1);
	});

	it("propagates a page's throw, so the loop host records the failure", async () => {
		await expect(
			drainPages(async () => {
				throw new Error("db down");
			}, { pageSize: 1, maxPages: 3 }),
		).rejects.toThrow("db down");
	});
});

describe("the retention windows (ADR 0001 §9, Q2)", () => {
	it("keeps a discarded draft 24 h and every other draft 30 days", () => {
		expect(DISCARDED_RETENTION_HOURS).toBe(24);
		expect(DRAFT_RETENTION_DAYS).toBe(30);
	});
});
