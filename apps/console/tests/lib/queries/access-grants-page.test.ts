// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Access list's server half.
//
// The interesting part of this surface is that TWO of its facet values are not columns:
//
//   * the role facet's `permission:<key>` and `—` values are a JS-side derivation over
//     (role_name, permission_key), and `rolePredicate` has to invert that derivation back
//     into SQL. If the two drift, selecting a role facet returns rows the facet did not count.
//   * "organization" is a CONSTANT the Scope column renders for an org-wide grant. A free-text
//     search for it must reach those rows even though no column contains the word.
//
// Both are pinned below. So is `projectId` being a UNIVERSE SELECTOR rather than a filter:
// on the project-scoped page the facet counts must describe that project, so its predicates
// belong to the scope, and both passes get them.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockChainDb } from "./_list-query-db";

vi.mock("drizzle-orm", async (importOriginal) => {
	const actual = await importOriginal<typeof import("drizzle-orm")>();
	return {
		...actual,
		ilike: vi.fn(actual.ilike),
		inArray: vi.fn(actual.inArray),
		isNull: vi.fn(actual.isNull),
	};
});

const { getServiceDb } = vi.hoisted(() => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb }));

import { ilike, inArray, isNull, SQL, sql } from "drizzle-orm";
import {
	GRANT_EFFECTS,
	GRANT_SCOPES,
	queryAccessGrantsPage,
} from "@/lib/queries/access-grants";
import { PgDialect } from "drizzle-orm/pg-core";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/queries/keyset";

const CREATED = new Date("2026-08-01T10:00:00.000Z");

/** A grants row as the ROWS pass projects it. */
function grantRow(over: Record<string, unknown> = {}) {
	return {
		id: "g1",
		principalType: "user",
		principalId: "11111111-2222-3333-4444-555555555555",
		principalName: "Ada Lovelace",
		principalEmail: "ada@x.io",
		teamName: null,
		effect: "allow",
		roleName: "admin",
		permissionKey: null,
		resourceType: "project",
		resourceId: "p1",
		createdAt: CREATED,
		...over,
	};
}

function seed(rows: unknown[], facets: unknown[]) {
	const { db, chains } = mockChainDb([rows, facets]);
	getServiceDb.mockReturnValue(db);
	return chains;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("queryAccessGrantsPage", () => {
	it("maps a row and counts facets over the unfiltered scope", async () => {
		seed(
			[grantRow()],
			[
				{ effect: "allow", resourceType: "project", roleName: "admin", permissionKey: null },
				{ effect: "deny", resourceType: "org", roleName: null, permissionKey: "runner.exec" },
				{ effect: "allow", resourceType: "org", roleName: null, permissionKey: null },
			],
		);

		const page = await queryAccessGrantsPage("org-1", { scopes: ["project"] });

		expect(page.rows).toEqual([
			{
				id: "g1",
				principalType: "user",
				principalId: "11111111-2222-3333-4444-555555555555",
				principalLabel: "Ada Lovelace",
				effect: "allow",
				roleName: "admin",
				permissionKey: null,
				resourceType: "project",
				resourceId: "p1",
				createdAt: "2026-08-01T10:00:00.000Z",
				// The instant this page was read, which "Granted … ago" is measured from.
				asOf: expect.any(String),
			},
		]);
		expect(page.nextCursor).toBeNull();
		expect(page.universeEmpty).toBe(false);
		expect(page.facets?.scopes).toEqual([
			{ value: "org", label: null, count: 2 },
			{ value: "project", label: null, count: 1 },
		]);
		expect(page.facets?.effects).toEqual([
			{ value: "allow", label: null, count: 2 },
			{ value: "deny", label: null, count: 1 },
		]);
	});

	it("derives the role facet the way the client does, and labels a permission grant", async () => {
		seed(
			[],
			[
				{ effect: "allow", resourceType: "org", roleName: "admin", permissionKey: null },
				{ effect: "allow", resourceType: "org", roleName: "k8s-readers", permissionKey: null },
				{ effect: "allow", resourceType: "org", roleName: null, permissionKey: "runner.exec" },
				{ effect: "allow", resourceType: "org", roleName: null, permissionKey: null },
			],
		);

		const page = await queryAccessGrantsPage("org-1");

		// A named role is its own value, LABELLED by the registry's one role-label source
		// (`admin` → `Admin`, a custom name exactly as typed — #5444); a bare permission gets the
		// `permission:` prefix and is labelled with the key alone; neither is the "—" bucket. Compared as a set: the
		// order is `localeCompare` over the labels, and where an em-dash sorts against a
		// letter is the platform's ICU collation to decide, not this module's contract.
		expect([...(page.facets?.roles ?? [])].sort((a, b) => a.value.localeCompare(b.value))).toEqual(
			[
				{ value: "admin", label: "Admin", count: 1 },
				{ value: "k8s-readers", label: "k8s-readers", count: 1 },
				{ value: "permission:runner.exec", label: "runner.exec", count: 1 },
				{ value: "—", label: "—", count: 1 },
			].sort((a, b) => a.value.localeCompare(b.value)),
		);
	});

	it("inverts each role-facet value back into its own SQL branch", async () => {
		seed([], []);
		await queryAccessGrantsPage("org-1", {
			roles: ["admin", "permission:runner.exec", "—"],
		});

		// A named role → `inArray(role.name, …)`; a prefixed value → `inArray(permission_key, …)`
		// with the prefix STRIPPED; the "—" bucket → both columns null, which is what roleKey
		// means by it (not "no role_id", which a deleted role row would also produce).
		const inArrayCalls = vi.mocked(inArray).mock.calls;
		expect(inArrayCalls.some((c) => Array.isArray(c[1]) && c[1].includes("admin"))).toBe(true);
		expect(
			inArrayCalls.some((c) => Array.isArray(c[1]) && c[1].includes("runner.exec")),
		).toBe(true);
		expect(
			inArrayCalls.some((c) => Array.isArray(c[1]) && c[1].includes("permission:runner.exec")),
		).toBe(false);
		expect(isNull).toHaveBeenCalledTimes(2);
	});

	it("does not build a role predicate at all for an empty role list", async () => {
		seed([], []);
		await queryAccessGrantsPage("org-1", { roles: [] });
		expect(isNull).not.toHaveBeenCalled();
	});

	it("reaches org-wide grants when the search matches the Scope column's constant", async () => {
		// "organization" is rendered, never stored. A prefix of it must still find those rows.
		const chains = seed([], []);
		await queryAccessGrantsPage("org-1", { search: "organ" });
		// Six name columns are searched, so `ilike` is composed six times — all in the rows
		// pass, which is where the search belongs. Both passes compose one WHERE each.
		expect(vi.mocked(ilike).mock.calls).toHaveLength(6);
		expect(chains[0].argsOf("where")).toHaveLength(1);
		expect(chains[1].argsOf("where")).toHaveLength(1);
	});

	it("treats projectId as the UNIVERSE, so the facet pass is scoped by it too", async () => {
		const chains = seed([], []);
		await queryAccessGrantsPage("org-1", { projectId: "p1", search: "ada" });

		// Both passes get the scope. The difference is that only the rows pass also gets the
		// filters, and `ilike` proves the search was composed once rather than twice.
		expect(chains[0].argsOf("where")).toHaveLength(1);
		expect(chains[1].argsOf("where")).toHaveLength(1);
		expect(chains[1].called("orderBy")).toBe(false);
		expect(vi.mocked(ilike).mock.calls.length).toBeGreaterThan(0);
	});

	it("falls back through team name, user name, email, then a truncated id", async () => {
		seed(
			[
				grantRow({ id: "a", teamName: "Platform" }),
				grantRow({ id: "b", teamName: null, principalName: null }),
				grantRow({ id: "c", teamName: null, principalName: null, principalEmail: null }),
			],
			[],
		);
		const page = await queryAccessGrantsPage("org-1");
		expect(page.rows.map((r) => r.principalLabel)).toEqual([
			"Platform",
			"ada@x.io",
			"11111111…",
		]);
	});

	it("normalises any non-deny effect to allow, in the row AND in the count", async () => {
		// The column is an enum, but the row mapper and the facet tally must not disagree
		// about what an unexpected value means, or the pill and the chip contradict.
		seed(
			[grantRow({ effect: "permit" })],
			[{ effect: "permit", resourceType: "org", roleName: null, permissionKey: null }],
		);
		const page = await queryAccessGrantsPage("org-1");
		expect(page.rows[0].effect).toBe("allow");
		expect(page.facets?.effects).toEqual([
			{ value: "allow", label: null, count: 1 },
			{ value: "deny", label: null, count: 0 },
		]);
	});

	it("exposes the scope and effect vocabularies the filter bar renders", () => {
		expect(GRANT_SCOPES).toEqual(["org", "project", "runner", "cloud_identity"]);
		expect(GRANT_EFFECTS).toEqual(["allow", "deny"]);
	});

	// ── the keyset walk (LST-8 #7490) ─────────────────────────────────────────────────────
	describe("pages on the keyset contract", () => {
		const SAME = new Date("2026-05-01T00:00:00.000Z");
		const dialect = new PgDialect({ casing: "snake_case" });
		/** A chain's SQL fragments for `method`, rendered as the service db renders them. */
		const render = (args: unknown[] | undefined) =>
			dialect.sqlToQuery(sql.join((args ?? []).filter((a): a is SQL => a instanceof SQL), sql`, `)).sql;
		/** Seeds result sets in await order: rows, then (first page) facets, then hydration. */
		const seedSets = (...sets: unknown[][]) => {
			const { db, chains } = mockChainDb(sets);
			getServiceDb.mockReturnValue(db);
			return chains;
		};

		it("orders newest first by the ms-truncated instant, then id, and reads limit + 1", async () => {
			const chains = seedSets([], []);
			await queryAccessGrantsPage("org-1", {}, { limit: 2 });
			expect(render(chains[0]?.argsOf("orderBy"))).toBe(
				`date_trunc('milliseconds', "grants"."created_at") desc, "grants"."id" desc`,
			);
			expect(chains[0]?.argsOf("limit")).toEqual([3]);
		});

		it("cuts at the limit and hands back the LAST kept row as the cursor — ties broken by id", async () => {
			// Three rows read for a page of two: the third proves a next page exists.
			seedSets([grantRow({ id: "cccc", createdAt: new Date("2026-05-03T00:00:00.000Z") }), grantRow({ id: "bbbb", createdAt: SAME }), grantRow({ id: "aaaa", createdAt: SAME })], []);
			const page = await queryAccessGrantsPage("org-1", {}, { limit: 2 });
			expect(page.rows.map((r) => r.id)).toEqual(["cccc", "bbbb"]);
			// bbbb and aaaa share a millisecond: the cursor carries bbbb's id, so aaaa is the next
			// page's first row rather than a row lost at the boundary.
			expect(decodeKeysetCursor(page.nextCursor ?? "", "text")).toEqual({
				at: "2026-05-01T00:00:00.000Z",
				id: "bbbb",
			});
		});

		it("says null at the end exactly — a full last page costs no empty read", async () => {
			seedSets([grantRow({ id: "cccc", createdAt: new Date("2026-05-03T00:00:00.000Z") }), grantRow({ id: "bbbb", createdAt: SAME })], []);
			const page = await queryAccessGrantsPage("org-1", {}, { limit: 2 });
			expect(page.rows).toHaveLength(2);
			expect(page.nextCursor).toBeNull();
		});

		it("applies the cursor as a row-value predicate and skips the facet pass on a later page", async () => {
			const cursor = decodeKeysetCursor(
				encodeKeysetCursor({ at: SAME, id: "00000000-0000-4000-8000-0000000000bb" }),
			);
			if (cursor === null) throw new Error("the test's cursor did not decode");
			const chains = seedSets([]);
			const page = await queryAccessGrantsPage("org-1", {}, { limit: 50, cursor });
			expect(render(chains[0]?.argsOf("where"))).toContain("< ($");
			// No facet pass: a later page walks the same universe and would count the same.
			expect(chains.filter((c) => c.awaited)).toHaveLength(1);
			expect(page.facets).toBeNull();
			expect(page.universeEmpty).toBeNull();
		});

		it("says the universe is empty on a first page over nothing — a boolean, never a count", async () => {
			seedSets([], []);
			const page = await queryAccessGrantsPage("org-1", {});
			expect(page.universeEmpty).toBe(true);
		});
	});
});
