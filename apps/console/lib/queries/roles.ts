// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, count, eq, exists, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { RoleRow } from "@/app/server/actions/roles";
import { BUILT_IN_ROLE_NAMES } from "@/lib/authz/registry";
import { getServiceDb } from "@/lib/db";
import { likeTerm } from "@/lib/db/like";
import { grants, role, rolePermission } from "@/lib/db/schema";
import { type FacetOption, narrowTo, orderedOptions, searchTerm } from "./facets";
import {
	KEYSET_DEFAULT_LIMIT,
	type KeysetListPage,
	type KeysetPageRequest,
	type KeysetPosition,
	keysetFetchLimit,
	keysetListPage,
	keysetPage,
} from "./keyset";

// The Settings › Roles rail's custom roles, filtered in SQL and paged on the console's ONE contract
// (lib/query/README.md → "Paging"; LST-8 #7490). Before this builder the rail read every custom role
// through `listRoles(search)`, with no facet pass (the Kind hint was a second, unsearched read of the
// whole list, counted in the browser) and no page.
//
// Service path with an explicit `organization_id` filter — the service role bypasses RLS, so the org
// scope is enforced here. The four BUILT-IN roles are not rows of this list: they are the product's
// fixed vocabulary, shipped with the role catalog (`members.roleCatalog`), and the rail narrows them
// in memory. They are counted here only as the Kind facet's `builtin` option, so the bar reads one
// facet answer.
//
// WHY NOT RECORDED AS `bounded`. The epic names roles as a list the product caps, but nothing caps
// custom roles today: `createRole` inserts without a ceiling. A `bounded` decision would name a bound
// that does not exist, so the rail pages.
//
// THE ORDER, AND THE ONE PLACE IT LEAVES THE CODEC'S SHAPE. The rail is alphabetical — a role is
// found by its name — and the `role` table has no creation instant to sort by, so the codec's usual
// `(sort instant, id)` order is not available. The order is `(lower(name), id)` ascending instead,
// still total (the id breaks ties between names that fold together). The cursor is still the shared
// opaque codec over the last row's id (uuid kind, so a malformed one is a 400 at the boundary); its
// instant is a constant, because the name the predicate compares against is read back from that
// row in the same statement. That keeps the cursor short and free of user text. The cost is
// stated rather than hidden: if the cursor's role is deleted between two pages, the comparison has
// nothing to compare with and the walk ends there — and the delete itself invalidates every
// `members.*` read (the rail's writes and the `access` live hint both do), which restarts the walk
// from page one with the deleted role gone.

/** The kinds of role the rail shows — the Kind facet's values. */
const ROLE_KINDS = ["builtin", "custom"] as const;

/** The roles rail's normalized filter query (the `normalizeRolesQuery()` output). */
export interface RolesQuery {
	/** Contains-match over a role's name, its description, or any of its permission keys. */
	search?: string;
	/** Which kinds the rail shows; empty/unknown = both. Only `custom` reaches rows here. */
	kinds?: string[];
}

/** The Kind facet: both kinds, always — the built-ins' fixed count, and the org's custom roles. */
export interface RolesFacets {
	kinds: FacetOption[];
}

/** One page of the custom roles (`KeysetListPage`): rows, the next cursor, and first-page facets. */
export type RolesPage = KeysetListPage<RoleRow, RolesFacets>;

/**
 * The instant every roles cursor carries. The `role` table has no creation time; the predicate
 * reads the cursor row's NAME back by its id instead (see the header), so this is a fixed value.
 */
const ROLE_CURSOR_AT = new Date(0);

/** The rail's sort key: the name, case-folded, so "beta" sorts between "Alpha" and "Gamma". */
const ROLE_SORT_NAME: SQL = sql`lower(${role.name})`;

/** The cursor row, read back inside the predicate to learn the name it sorts under. */
const cursorRole = alias(role, "cursor_role");

/**
 * Rows strictly after `cursor` in `(lower(name), id)` order — one row-value comparison against the
 * cursor row as it reads now, scoped to the org so a cursor can never name another org's role.
 */
function roleAfter(orgId: string, cursor: KeysetPosition | undefined): SQL | undefined {
	if (cursor === undefined) return undefined;
	const at = getServiceDb()
		.select({ name: sql`lower(${cursorRole.name})`, id: cursorRole.id })
		.from(cursorRole)
		.where(and(eq(cursorRole.id, cursor.id), eq(cursorRole.organization_id, orgId)));
	return sql`(${ROLE_SORT_NAME}, ${role.id}) > (${at})`;
}

/**
 * Distinct-USER grant counts per role in an org. Counts only `user` principals (team grants
 * contribute 0) and de-duplicates a principal holding the role both org-wide and scoped, so
 * "N members affected" is accurate. Roles with no grants are absent (→ 0). `roleIds` narrows the
 * read to those roles (a page's), and an empty list reads nothing.
 */
export async function grantCountsByRole(orgId: string, roleIds?: string[]): Promise<Map<string, number>> {
	if (roleIds?.length === 0) return new Map();
	const rows = await getServiceDb()
		.select({
			roleId: grants.role_id,
			n: sql<number>`count(distinct case when ${grants.principal_type} = 'user' then ${grants.principal_id} end)`,
		})
		.from(grants)
		.where(
			and(
				eq(grants.org_id, orgId),
				isNotNull(grants.role_id),
				roleIds ? inArray(grants.role_id, roleIds) : undefined,
			),
		)
		.groupBy(grants.role_id);
	const map = new Map<string, number>();
	for (const r of rows) if (r.roleId) map.set(r.roleId, Number(r.n));
	return map;
}

/** Groups `role_permission` rows into a role id → permission keys map. */
export async function permissionKeysByRole(roleIds: string[]): Promise<Map<string, string[]>> {
	if (roleIds.length === 0) return new Map();
	const perms = await getServiceDb()
		.select({ roleId: rolePermission.role_id, key: rolePermission.permission_key })
		.from(rolePermission)
		.where(inArray(rolePermission.role_id, roleIds));
	const byRole = new Map<string, string[]>();
	for (const p of perms) {
		const list = byRole.get(p.roleId) ?? [];
		list.push(p.key);
		byRole.set(p.roleId, list);
	}
	return byRole;
}

/**
 * The search predicate over a custom role: its name, its description, or any of its permission
 * keys (LIKE-escaped by `likeTerm`).
 */
function roleSearchPredicate(like: string): SQL | undefined {
	return or(
		sql`${role.name} ilike ${like}`,
		sql`${role.description} ilike ${like}`,
		exists(
			getServiceDb()
				.select({ one: sql`1` })
				.from(rolePermission)
				.where(and(eq(rolePermission.role_id, role.id), sql`${rolePermission.permission_key} ilike ${like}`)),
		),
	);
}

/**
 * One page of the org's custom roles for `query`, alphabetical — rows filtered in SQL, each with its
 * permission keys and distinct-user grant count, plus (on the first page only) the Kind facet over
 * the UNFILTERED universe: the facet pass below is given the org predicate and nothing from the
 * query, so an option never disappears as you pick it. A later page carries `facets: null`.
 *
 * A `kinds` selection without `custom` answers no rows at all (the rail shows only built-ins), and
 * still the facets, so the bar can offer `custom` back with its count.
 */
export async function queryRolesPage(
	orgId: string,
	query: RolesQuery = {},
	request: KeysetPageRequest = { limit: KEYSET_DEFAULT_LIMIT },
): Promise<RolesPage> {
	const db = getServiceDb();
	const search = searchTerm(query.search);
	const kinds = narrowTo(ROLE_KINDS, query.kinds);
	const wantsCustom = !kinds || kinds.includes("custom");
	const firstPage = request.cursor === undefined;

	const [fetched, universe] = await Promise.all([
		// ROWS: org scope + custom only + the query's search + the cursor, `limit + 1` of them.
		wantsCustom
			? db
					.select({ id: role.id, name: role.name, description: role.description })
					.from(role)
					.where(
						and(
							eq(role.organization_id, orgId),
							eq(role.is_builtin, false),
							search ? roleSearchPredicate(likeTerm(search)) : undefined,
							roleAfter(orgId, request.cursor),
						),
					)
					.orderBy(sql`${ROLE_SORT_NAME} asc`, sql`${role.id} asc`)
					.limit(keysetFetchLimit(request.limit))
			: [],
		// FACETS (first page only): the org predicate ONLY — how many custom roles the org has.
		// Never sees `search`, `kinds` or the cursor; that is the invariant.
		firstPage
			? db
					.select({ n: count() })
					.from(role)
					.where(and(eq(role.organization_id, orgId), eq(role.is_builtin, false)))
			: [],
	]);
	const cut = keysetPage(fetched, request.limit, (r) => ({ at: ROLE_CURSOR_AT, id: r.id }));

	const ids = cut.rows.map((r) => r.id);
	const [byRole, counts] = await Promise.all([permissionKeysByRole(ids), grantCountsByRole(orgId, ids)]);
	const rows: RoleRow[] = cut.rows.map((r) => ({
		id: r.id,
		name: r.name,
		description: r.description,
		builtin: false,
		permissionKeys: byRole.get(r.id) ?? [],
		grantCount: counts.get(r.id) ?? 0,
	}));
	const page = { rows, nextCursor: cut.nextCursor };
	if (!firstPage) return keysetListPage(page, null);

	const customTotal = Number(universe[0]?.n ?? 0);
	return keysetListPage(page, {
		facets: {
			kinds: orderedOptions(
				new Map([
					["builtin", BUILT_IN_ROLE_NAMES.length],
					["custom", customTotal],
				]),
				ROLE_KINDS,
			),
		},
		universeEmpty: customTotal === 0,
	});
}

