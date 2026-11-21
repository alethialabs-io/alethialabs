// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The privacy policy's "support correspondence: up to 3 years after the matter closes", enforced
// (lib/retention/support-correspondence.ts).
//
// Pinned: the window IS the register's published number; only CLOSED cases past it are asked for;
// their attachment files are deleted from storage BEFORE the rows that name them; and a pass with
// nothing expired deletes nothing.

import { describe, expect, it, vi } from "vitest";
import { scriptedDb, whereParams, whereSql } from "../../privacy/scripted-db";

import { supportCases } from "@/lib/db/schema";
import { RETENTION_DEFAULT_DAYS, retentionEntry } from "@/lib/retention/registry";
import { gcSupportCorrespondence, supportCorrespondenceCutoff } from "@/lib/retention/support-correspondence";

const NOW = new Date("2029-12-01T00:00:00.000Z");

describe("gcSupportCorrespondence", () => {
	it("uses the three-year window the register publishes", () => {
		expect(RETENTION_DEFAULT_DAYS.supportCorrespondence).toBe(3 * 365);
		expect(retentionEntry("support-correspondence")?.windowDays).toBe(3 * 365);
		expect(supportCorrespondenceCutoff(NOW)).toEqual(new Date(NOW.getTime() - 3 * 365 * 86_400_000));
	});

	it("deletes closed cases past the window, their files first", async () => {
		const sdb = scriptedDb();
		const order: string[] = [];
		const del = vi.fn(async (_bucket: string, key: string) => {
			order.push(`file:${key}`);
		});
		sdb.answer([{ id: "case-1" }], [{ key: "support/o/case-1/a/f.txt" }], [{ id: "case-1" }]);
		// @ts-expect-error — the scripted fake stands in for the drizzle client.
		const out = await gcSupportCorrespondence(sdb.db, NOW, { put: vi.fn(), get: vi.fn(), del });
		expect(out).toEqual({ deleted: 1 });
		expect(order).toEqual(["file:support/o/case-1/a/f.txt"]);
		const [select] = sdb.calls;
		expect(whereSql(select)).toContain('"status" = $');
		expect(whereParams(select)).toContain("closed");
		const deletion = sdb.calls.find((c) => c.op === "delete");
		expect(deletion?.table).toBe(supportCases);
		expect(sdb.calls.indexOf(deletion ?? sdb.calls[0])).toBeGreaterThan(1);
	});

	it("deletes nothing when no closed case is old enough", async () => {
		const sdb = scriptedDb();
		sdb.answer([]);
		// @ts-expect-error — the scripted fake stands in for the drizzle client.
		expect(await gcSupportCorrespondence(sdb.db, NOW, { put: vi.fn(), get: vi.fn(), del: vi.fn() })).toEqual({
			deleted: 0,
		});
		expect(sdb.calls.filter((c) => c.op === "delete")).toEqual([]);
	});
});
