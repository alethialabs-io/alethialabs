// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The drafts retention sweep's paging (lib/elench/drafts-sweep.ts). The SQL itself — what is
// deleted, what is settled, what a `sending` row is spared — runs against real Postgres in
// tests/integration/elench-drafts-sweep.test.ts; this file pins the bound a run may not exceed.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({}));
vi.mock("@/lib/elench/draft-claims", () => ({ settleIfSilent: vi.fn() }));
const logged = vi.hoisted(() => ({ lines: [] as unknown[] }));
vi.mock("@/lib/observability/log", () => {
	const sink = {
		error: (...args: unknown[]) => logged.lines.push(args),
		warn: (...args: unknown[]) => logged.lines.push(args),
		info: () => undefined,
		debug: () => undefined,
	};
	return { log: { child: () => sink } };
});

import type { Db } from "@/lib/db";
import { retentionEntry } from "@/lib/retention/registry";
import {
	DISCARDED_RETENTION_HOURS,
	DRAFT_RETENTION_DAYS,
	drainPages,
	sweepElenchDrafts,
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

	it("are the windows the retention register publishes", () => {
		expect(retentionEntry("elench-drafts")).toMatchObject({
			table: "elench_drafts",
			mechanism: "reconcile-task",
			windowDays: DRAFT_RETENTION_DAYS,
		});
		expect(retentionEntry("elench-drafts-discarded")?.windowDays).toBe(DISCARDED_RETENTION_HOURS / 24);
	});
});

describe("a failing sweep never leaks a statement's parameters", () => {
	// drizzle's DrizzleQueryError message is "Failed query: <sql>\nparams: <params>", and a settle's
	// params include the row's claim token. The loop host stores a task's thrown message as lastError.
	const TOKEN = "0b5e3a52-claim-token-must-not-leak";

	it("runs every phase, then throws names only, and logs names only", async () => {
		logged.lines = [];
		const fail = (): never => {
			throw new Error(`Failed query: update "elench_drafts" ...\nparams: ${TOKEN}`);
		};
		const db = { select: fail, transaction: fail, delete: fail } as unknown as Db;
		const thrown = await sweepElenchDrafts(db, { pageSize: 10, maxPages: 1 }).then(
			() => "resolved",
			(e: unknown) => String(e),
		);
		expect(thrown).toBe(
			"Error: elench-drafts-sweep: settle (Error), discarded (Error), stale (Error) failed",
		);
		expect(thrown).not.toContain(TOKEN);
		expect(logged.lines).toHaveLength(3);
		expect(JSON.stringify(logged.lines)).not.toContain(TOKEN);
	});
});
