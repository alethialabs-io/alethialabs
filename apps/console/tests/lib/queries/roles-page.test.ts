// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The roles rail's server half (`queryRolesPage`, LST-8 #7490): custom roles filtered in SQL and
// paged alphabetically on the shared keyset codec, with the Kind facet counted over the UNFILTERED
// universe on the first page only.
//
// Await order: rows (absent when `kinds` excludes custom), facet count (first page only), then the
// two hydration reads for the page's roles (permission keys, grant counts) when it has any.

import { SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockChainDb } from "./_list-query-db";

const { getServiceDb } = vi.hoisted(() => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb }));

import { decodeKeysetTextCursor } from "@/lib/queries/keyset";
import { queryRolesPage } from "@/lib/queries/roles";

const dialect = new PgDialect({ casing: "snake_case" });

/** A recorded call's SQL fragments, rendered the way the service db renders them. */
function render(args: unknown[] | undefined): string {
	return dialect.sqlToQuery(sql.join((args ?? []).filter((a): a is SQL => a instanceof SQL), sql`, `)).sql;
}

/** Seeds result sets in await order. */
function seed(...sets: unknown[][]) {
	const { db, chains } = mockChainDb(sets);
	getServiceDb.mockReturnValue(db);
	return chains;
}

const ROLE_A = "00000000-0000-4000-8000-00000000000a";
const ROLE_B = "00000000-0000-4000-8000-00000000000b";
const ROLE_C = "00000000-0000-4000-8000-00000000000c";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("queryRolesPage", () => {
	it("returns a page of custom roles with their keys and grant counts, and the Kind facet", async () => {
		seed(
			[{ id: ROLE_A, name: "Auditor", description: "Reads everything" }],
			[{ n: 3 }],
			[{ roleId: ROLE_A, key: "member:view" }],
			[{ roleId: ROLE_A, n: 2 }],
		);
		const page = await queryRolesPage("org-1", { search: "aud" });
		expect(page.rows).toEqual([
			{
				id: ROLE_A,
				name: "Auditor",
				description: "Reads everything",
				builtin: false,
				permissionKeys: ["member:view"],
				grantCount: 2,
			},
		]);
		expect(page.nextCursor).toBeNull();
		// The facet counts the org's three custom roles — not the one the search matched — and the
		// four built-ins, always.
		expect(page.facets?.kinds).toEqual([
			{ value: "builtin", label: null, count: 4 },
			{ value: "custom", label: null, count: 3 },
		]);
		expect(page.universeEmpty).toBe(false);
	});

	it("hands the facet pass the org predicate and nothing from the query", async () => {
		const chains = seed([], [{ n: 0 }]);
		await queryRolesPage("org-1", { search: "needle-xyz" });
		const awaited = chains.filter((c) => c.awaited);
		const facet = awaited[1];
		expect(render(facet?.argsOf("where"))).not.toContain("ilike");
		expect(render(awaited[0]?.argsOf("where"))).toContain("ilike");
	});

	it("orders alphabetically, case-folded, then by id — and reads limit + 1", async () => {
		const chains = seed([], [{ n: 0 }]);
		await queryRolesPage("org-1", {}, { limit: 2 });
		expect(render(chains[0]?.argsOf("orderBy"))).toBe('lower("role"."name") collate "C" asc, "role"."id" asc');
		expect(chains[0]?.argsOf("limit")).toEqual([3]);
	});

	it("cuts at the limit and carries the last kept role's sort text and id in the cursor", async () => {
		seed(
			[
				{ id: ROLE_A, name: "Alpha", description: null, sortText: "alpha" },
				{ id: ROLE_B, name: "beta", description: null, sortText: "beta" },
				{ id: ROLE_C, name: "Gamma", description: null, sortText: "gamma" },
			],
			[{ n: 3 }],
		);
		const page = await queryRolesPage("org-1", {}, { limit: 2 });
		expect(page.rows.map((r) => r.id)).toEqual([ROLE_A, ROLE_B]);
		expect(decodeKeysetTextCursor(page.nextCursor ?? "")).toEqual({ text: "beta", id: ROLE_B });
	});

	it("walks strictly after the cursor's own (name, id) — no read-back, so a deleted role cannot end the walk", async () => {
		// The cursor names ROLE_B; whether ROLE_B still exists is irrelevant — the predicate compares
		// against the values the cursor carries, so the next page starts where ROLE_B WAS.
		const chains = seed([]);
		const page = await queryRolesPage("org-1", {}, { limit: 50, cursor: { text: "beta", id: ROLE_B } });
		const q = dialect.sqlToQuery(
			sql.join((chains.find((c) => c.awaited)?.argsOf("where") ?? []).filter((a): a is SQL => a instanceof SQL)),
		);
		expect(q.sql).toContain('(lower("role"."name") collate "C", "role"."id") > ($');
		expect(q.params).toEqual(expect.arrayContaining(["beta", ROLE_B]));
		// One awaited read and no subquery reading the role back.
		expect(chains).toHaveLength(1);
		expect(page.facets).toBeNull();
		expect(page.universeEmpty).toBeNull();
	});

	it("reads one custom role by id — the deep link — inside the org scope", async () => {
		const chains = seed([{ id: ROLE_C, name: "Zeta", description: null, sortText: "zeta" }], [{ n: 120 }]);
		const page = await queryRolesPage("org-1", { id: ROLE_C });
		expect(page.rows.map((r) => r.id)).toEqual([ROLE_C]);
		const q = dialect.sqlToQuery(sql.join((chains[0]?.argsOf("where") ?? []).filter((a): a is SQL => a instanceof SQL)));
		expect(q.params).toEqual(expect.arrayContaining(["org-1", ROLE_C]));
	});

	it("answers no rows when the kind selection excludes custom, but still offers the facet", async () => {
		const chains = seed([{ n: 5 }]);
		const page = await queryRolesPage("org-1", { kinds: ["builtin"] });
		expect(page.rows).toEqual([]);
		expect(chains.filter((c) => c.awaited)).toHaveLength(1);
		expect(page.facets?.kinds.find((o) => o.value === "custom")?.count).toBe(5);
	});

	it("says the custom universe is empty with a boolean", async () => {
		seed([], [{ n: 0 }]);
		const page = await queryRolesPage("org-1");
		expect(page.universeEmpty).toBe(true);
	});
});
