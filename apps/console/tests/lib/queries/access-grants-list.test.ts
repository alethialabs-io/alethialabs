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

import { ilike, inArray, isNull } from "drizzle-orm";
import {
	GRANT_EFFECTS,
	GRANT_SCOPES,
	queryAccessGrantsPage,
} from "@/lib/queries/access-grants";

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
			},
		]);
		expect(page.resultCount).toBe(1);
		expect(page.total).toBe(3);
		expect(page.facets.scopes).toEqual([
			{ value: "org", label: null, count: 2 },
			{ value: "project", label: null, count: 1 },
		]);
		expect(page.facets.effects).toEqual([
			{ value: "allow", label: null, count: 2 },
			{ value: "deny", label: null, count: 1 },
		]);
	});

	it("derives the role facet the way the client does, and labels a permission grant", async () => {
		seed(
			[],
			[
				{ effect: "allow", resourceType: "org", roleName: "admin", permissionKey: null },
				{ effect: "allow", resourceType: "org", roleName: null, permissionKey: "runner.exec" },
				{ effect: "allow", resourceType: "org", roleName: null, permissionKey: null },
			],
		);

		const page = await queryAccessGrantsPage("org-1");

		// A named role is its own value; a bare permission gets the `permission:` prefix and
		// is LABELLED with the key alone; neither is the "—" bucket. Compared as a set: the
		// order is `localeCompare` over the labels, and where an em-dash sorts against a
		// letter is the platform's ICU collation to decide, not this module's contract.
		expect([...page.facets.roles].sort((a, b) => a.value.localeCompare(b.value))).toEqual(
			[
				{ value: "admin", label: "admin", count: 1 },
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
		expect(page.facets.effects).toEqual([
			{ value: "allow", label: null, count: 1 },
			{ value: "deny", label: null, count: 0 },
		]);
	});

	it("exposes the scope and effect vocabularies the filter bar renders", () => {
		expect(GRANT_SCOPES).toEqual(["org", "project", "runner", "cloud_identity"]);
		expect(GRANT_EFFECTS).toEqual(["allow", "deny"]);
	});
});
