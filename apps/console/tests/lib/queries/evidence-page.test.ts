// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The recorded-waivers list's server half (#7488): `queryEvidenceWaiversPage` on the console paging
// contract. Before it, the waivers rode inside the evidence roll-up behind `.limit(100)`, so waiver
// 101 and later were unreachable. What is locked here, against a recording db stub (the SQL itself
// runs in tests/integration/evidence-waivers-page.test.ts):
//
//   - ONE rows pass, reading `limit + 1` rows — never a fixed cap — ordered by the ms-truncated
//     recorded time then the job id, both descending;
//   - the cursor of a full page is the LAST KEPT row's (ms instant, id), so ties on the instant fall
//     to the id and the next page starts strictly after it;
//   - a later page carries that cursor into the WHERE as a row-value comparison;
//   - page one answers `universeEmpty`, a later page `null`; `facets` is null on every page (the
//     list has no filter bar, so there is no facet pass to issue);
//   - the waiver's verdict (`active`) comes from the read, not from a clock in this process.

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockChainDb } from "./_list-query-db";

const { getServiceDb } = vi.hoisted(() => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb }));

import { queryEvidenceWaiversPage } from "@/lib/queries/evidence";
import { decodeKeysetCursor, KEYSET_DEFAULT_LIMIT } from "@/lib/queries/keyset";

const ORG = "org-1";
const PROJECTS = ["11111111-1111-4111-8111-111111111111"];

/** A uuid whose trailing digits are `n`. */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** One waiver read row, as the builder's projection selects it. */
function readRow(n: number, createdAt: Date, active = true) {
	return {
		jobId: uuid(n),
		override: { controls: ["KEYLESS-001"], reason: `reason ${n}`, by: "ada@example.test" },
		projectName: "payments",
		environmentName: "prod",
		createdAt,
		active,
	};
}

/** Renders a recorded drizzle predicate to its SQL text and parameters. */
function render(predicate: unknown): { sql: string; params: unknown[] } {
	const q = new PgDialect().sqlToQuery(predicate as SQL);
	return { sql: q.sql, params: q.params };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("queryEvidenceWaiversPage", () => {
	it("reads limit + 1 rows in one pass, newest first with the id breaking ties — no fixed cap", async () => {
		const { db, chains } = mockChainDb([[]]);
		getServiceDb.mockReturnValue(db);
		await queryEvidenceWaiversPage(ORG, PROJECTS, { limit: KEYSET_DEFAULT_LIMIT });

		expect(chains).toHaveLength(1);
		const [rows] = chains;
		expect(rows?.argsOf("limit")).toEqual([KEYSET_DEFAULT_LIMIT + 1]);
		const order = (rows?.argsOf("orderBy") ?? []).map((o) => render(o).sql);
		expect(order).toEqual([
			expect.stringMatching(/^date_trunc\('milliseconds', "jobs"\."created_at"\) desc$/),
			expect.stringMatching(/^"jobs"\."id" desc$/),
		]);
	});

	it("a full page mints the cursor of its LAST KEPT row, ties on the instant included", async () => {
		// 51 rows (limit 50 + 1) that all share ONE recorded instant: only the id orders them.
		const tie = new Date("2026-11-20T10:00:00.123Z");
		const fetched = Array.from({ length: 51 }, (_, i) => readRow(1000 - i, tie));
		const { db } = mockChainDb([fetched]);
		getServiceDb.mockReturnValue(db);

		const page = await queryEvidenceWaiversPage(ORG, PROJECTS, { limit: 50 });

		expect(page.rows).toHaveLength(50);
		expect(page.rows.at(-1)?.id).toBe(uuid(951));
		expect(page.nextCursor).not.toBeNull();
		expect(decodeKeysetCursor(page.nextCursor ?? "")).toEqual({ at: tie.toISOString(), id: uuid(951) });
		// Page one: no facets (no bar), and the scope is not empty.
		expect(page.facets).toBeNull();
		expect(page.universeEmpty).toBe(false);
	});

	it("the page that reaches the end says so exactly: no cursor, not a guess", async () => {
		const fetched = Array.from({ length: 50 }, (_, i) => readRow(500 - i, new Date(Date.UTC(2026, 10, 20, 10, 0, 50 - i))));
		const { db } = mockChainDb([fetched]);
		getServiceDb.mockReturnValue(db);
		const page = await queryEvidenceWaiversPage(ORG, PROJECTS, { limit: 50 });
		expect(page.rows).toHaveLength(50);
		expect(page.nextCursor).toBeNull();
	});

	it("a later page reads strictly after the cursor, and carries neither facets nor universeEmpty", async () => {
		const cursor = { at: "2026-11-20T10:00:00.123Z", id: uuid(951) };
		const { db, chains } = mockChainDb([[readRow(950, new Date(cursor.at))]]);
		getServiceDb.mockReturnValue(db);

		const page = await queryEvidenceWaiversPage(ORG, PROJECTS, { cursor, limit: 50 });

		const where = render(chains[0]?.argsOf("where")?.[0]);
		expect(where.sql).toMatch(/\(date_trunc\('milliseconds', "jobs"\."created_at"\), "jobs"\."id"\) < \(\$\d+::timestamptz, \$\d+::uuid\)/);
		expect(where.params).toEqual(expect.arrayContaining([cursor.at, cursor.id]));
		expect(page.rows.map((r) => r.id)).toEqual([uuid(950)]);
		expect(page.facets).toBeNull();
		expect(page.universeEmpty).toBeNull();
	});

	it("page one with nothing in scope is the universe-empty state", async () => {
		const { db } = mockChainDb([[]]);
		getServiceDb.mockReturnValue(db);
		const page = await queryEvidenceWaiversPage(ORG, PROJECTS, { limit: 50 });
		expect(page).toEqual({ rows: [], nextCursor: null, facets: null, universeEmpty: true });
	});

	it("page one is scoped to the org, the override and the visible projects (or org-level jobs)", async () => {
		const { db, chains } = mockChainDb([[]]);
		getServiceDb.mockReturnValue(db);
		await queryEvidenceWaiversPage(ORG, PROJECTS, { limit: 50 });
		const where = render(chains[0]?.argsOf("where")?.[0]);
		expect(where.sql).toContain('"jobs"."org_id" = $');
		expect(where.sql).toContain('"jobs"."verify_override" is not null');
		expect(where.sql).toContain('"jobs"."project_id" is null and "jobs"."environment_id" is null');
		expect(where.params).toEqual(expect.arrayContaining([ORG, ...PROJECTS]));
		// Page one has no cursor predicate.
		expect(where.sql).not.toContain("::timestamptz, $");
	});

	it("keeps an expired waiver in the log, with the verdict the read decided", async () => {
		const { db } = mockChainDb([[readRow(2, new Date("2026-11-20T10:00:02.000Z"), true), readRow(1, new Date("2026-11-20T10:00:01.000Z"), false)]]);
		getServiceDb.mockReturnValue(db);
		const page = await queryEvidenceWaiversPage(ORG, PROJECTS, { limit: 50 });
		expect(page.rows.map((r) => [r.id, r.jobId, r.active])).toEqual([
			[uuid(2), uuid(2), true],
			[uuid(1), uuid(1), false],
		]);
		expect(page.rows[0]).toMatchObject({ reason: "reason 2", controls: ["KEYLESS-001"], expiry: null, createdAt: "2026-11-20T10:00:02.000Z" });
	});
});
