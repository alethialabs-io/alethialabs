// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, eq, ilike, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { AccessGrantRow } from "@/app/server/actions/grants";
import { roleDisplayName } from "@/lib/authz/registry";
import { getServiceDb } from "@/lib/db";
import { likeTerm } from "@/lib/db/like";
import {
	cloudIdentities,
	grants,
	projects,
	role,
	runners,
	team,
	user,
} from "@/lib/db/schema";
import {
	asOptions,
	type FacetOption,
	narrowTo,
	nonEmpty,
	orderedOptions,
	searchTerm,
	tally,
} from "./facets";
import {
	KEYSET_DEFAULT_LIMIT,
	type KeysetListPage,
	type KeysetPageRequest,
	keysetAfter,
	keysetFetchLimit,
	keysetListPage,
	keysetOrderBy,
	keysetPage,
	keysetSortKey,
} from "./keyset";

// The Settings › Access grants list, filtered in SQL (the console filter standard's server
// half). Service path with an explicit `org_id` filter — the service role bypasses RLS, so
// the org scope is enforced here, exactly as the unfiltered `listAccessGrants()` does.
//
// Paged on the console's ONE contract (lib/query/README.md → "Paging"; LST-8 #7490): newest grant
// first by `created_at` truncated to the millisecond, then the id, through the shared keyset codec
// — the order this list always showed, now a page at a time instead of every grant in the scope.
//
// `AccessGrantRow` stays defined in the action module (components import it from there);
// the import above is type-only, so it is erased and no runtime cycle exists.

/** The resource levels a grant can be scoped to — the scope facet's values. */
export const GRANT_SCOPES = [
	"org",
	"project",
	"runner",
	"cloud_identity",
] as const;

export type GrantScope = (typeof GRANT_SCOPES)[number];

/** A grant is allow or deny; deny wins at any covered scope. */
export const GRANT_EFFECTS = ["allow", "deny"] as const;

/** The facet value of a grant carrying neither a role nor a permission key. */
const NO_ROLE = "—";

/** The prefix marking a role-facet value that is a direct permission grant. */
const PERMISSION_PREFIX = "permission:";

/** The label the Scope column shows for an org-wide grant (searchable as such). */
const ORG_SCOPE_LABEL = "organization";

/** The Access list's normalized filter query (the `normalizeAccessQuery()` output). */
export interface AccessGrantQuery {
	/**
	 * The project-scoped Access surface. This is the UNIVERSE SELECTOR, not a filter: when
	 * present, both the rows and the facet counts are computed within that project's grants
	 * (the page is "this project's access", and its facets must describe that page).
	 */
	projectId?: string;
	/** Contains-match over what a row DISPLAYS: the principal and the scoped resource. */
	search?: string;
	/** Restrict to these scope levels; empty/unknown = all. */
	scopes?: string[];
	/** Role names, or `permission:<key>` for a direct permission grant, or `—`. */
	roles?: string[];
	/** "allow" / "deny"; empty = both. */
	effects?: string[];
}

/** The facets behind the Access filter bar, over the UNFILTERED grants of the scope. */
export interface AccessGrantFacets {
	scopes: FacetOption[];
	roles: FacetOption[];
	/** Both effects, always. */
	effects: FacetOption[];
}

/**
 * One grant of the list. `asOf` is when the page holding it was read (ISO), the instant "Granted …
 * ago" is computed against — carried in the payload so the server render and the hydrating client
 * print the same string (React #418, the members page's #5377 rule).
 */
export interface AccessGrantListRow extends AccessGrantRow {
	asOf: string;
}

/** One page of the Access list (`KeysetListPage`): rows, the next cursor, and first-page facets. */
export type AccessGrantsPage = KeysetListPage<AccessGrantListRow, AccessGrantFacets>;

/** A grant's keyset sort key — when it was made, truncated to the millisecond. */
const GRANT_LISTED_AT: SQL = keysetSortKey(grants.created_at);

/** The role-facet value a grant falls under — the value the Roles combobox sends back. */
function roleKey(roleName: string | null, permissionKey: string | null): string {
	if (roleName) return roleName;
	return permissionKey ? `${PERMISSION_PREFIX}${permissionKey}` : NO_ROLE;
}

/** The human label for a role-facet value: a direct permission grant shows its key, a role its
 *  on-screen name from the registry (`owner` → `Owner`; a custom name exactly as typed). */
function roleLabel(value: string): string {
	return value.startsWith(PERMISSION_PREFIX)
		? value.slice(PERMISSION_PREFIX.length)
		: roleDisplayName(value);
}

/** The predicate selecting the role-facet values in `values` (undefined = no filter). */
function rolePredicate(values: string[]): SQL | undefined {
	const names = values.filter(
		(v) => v !== NO_ROLE && !v.startsWith(PERMISSION_PREFIX),
	);
	const permissions = values
		.filter((v) => v.startsWith(PERMISSION_PREFIX))
		.map((v) => v.slice(PERMISSION_PREFIX.length));
	return or(
		names.length ? inArray(role.name, names) : undefined,
		permissions.length ? inArray(grants.permission_key, permissions) : undefined,
		// Mirrors `roleKey` exactly: the "—" bucket is "no ROLE NAME resolved and no
		// permission key", which is not the same as "no role_id" when a role row is gone.
		values.includes(NO_ROLE)
			? and(isNull(role.name), isNull(grants.permission_key))
			: undefined,
	);
}

/**
 * One page of the org's access grants for `query`, newest first — rows filtered in SQL, plus (on the
 * first page only) facet counts over the UNFILTERED grants of the same scope (org, or one project
 * when `projectId` is given). The facet pass below is handed the scope predicates and NOTHING from
 * the filters or the cursor, which is what keeps an option from disappearing the moment it is
 * selected. A later page carries `facets: null`.
 */
export async function queryAccessGrantsPage(
	orgId: string,
	query: AccessGrantQuery = {},
	request: KeysetPageRequest = { limit: KEYSET_DEFAULT_LIMIT },
): Promise<AccessGrantsPage> {
	const db = getServiceDb();
	const asOf = new Date().toISOString();
	const firstPage = request.cursor === undefined;
	const search = searchTerm(query.search);
	const like = search ? likeTerm(search) : undefined;
	const scopes = narrowTo(GRANT_SCOPES, query.scopes);
	const effects = narrowTo(GRANT_EFFECTS, query.effects);
	const roles = nonEmpty(query.roles);

	// The universe: this org, narrowed to one project's grants on the project-scoped surface.
	const scopeConditions = [
		eq(grants.org_id, orgId),
		query.projectId ? eq(grants.resource_type, "project") : undefined,
		query.projectId ? eq(grants.resource_id, query.projectId) : undefined,
	].filter((c) => c !== undefined);

	// "organization" is a CONSTANT the Scope column renders for an org-wide grant, not a
	// value in any column — so it is matched here, against the literal, and turned into a
	// predicate over `resource_type`. No data is filtered in JS.
	const matchesOrgLabel = Boolean(
		search && ORG_SCOPE_LABEL.includes(search.toLowerCase()),
	);

	const filterConditions = [
		scopes ? inArray(grants.resource_type, scopes) : undefined,
		effects ? inArray(grants.effect, effects) : undefined,
		roles ? rolePredicate(roles) : undefined,
		like
			? or(
					ilike(user.name, like),
					ilike(user.email, like),
					ilike(team.name, like),
					ilike(projects.project_name, like),
					ilike(runners.name, like),
					ilike(cloudIdentities.name, like),
					matchesOrgLabel ? eq(grants.resource_type, "org") : undefined,
				)
			: undefined,
	].filter((c) => c !== undefined);

	const [fetched, facetRows] = await Promise.all([
		// ROWS: scope + the query's predicates + the cursor, `limit + 1` of them. The resource
		// joins exist so the free-text search can reach the names the Scope column shows.
		db
			.select({
				id: grants.id,
				principalType: grants.principal_type,
				principalId: grants.principal_id,
				principalName: user.name,
				principalEmail: user.email,
				teamName: team.name,
				effect: grants.effect,
				roleName: role.name,
				permissionKey: grants.permission_key,
				resourceType: grants.resource_type,
				resourceId: grants.resource_id,
				createdAt: grants.created_at,
			})
			.from(grants)
			.leftJoin(user, eq(grants.principal_id, user.id))
			.leftJoin(role, eq(grants.role_id, role.id))
			.leftJoin(
				team,
				and(eq(grants.principal_type, "team"), eq(grants.principal_id, team.id)),
			)
			.leftJoin(
				projects,
				and(
					eq(grants.resource_type, "project"),
					eq(grants.resource_id, projects.id),
					eq(projects.org_id, orgId),
				),
			)
			.leftJoin(
				runners,
				and(
					eq(grants.resource_type, "runner"),
					eq(grants.resource_id, runners.id),
					eq(runners.org_id, orgId),
				),
			)
			.leftJoin(
				cloudIdentities,
				and(
					eq(grants.resource_type, "cloud_identity"),
					eq(grants.resource_id, cloudIdentities.id),
					eq(cloudIdentities.org_id, orgId),
				),
			)
			.where(
				and(
					...scopeConditions,
					...filterConditions,
					keysetAfter(GRANT_LISTED_AT, grants.id, request.cursor),
				),
			)
			.orderBy(...keysetOrderBy(GRANT_LISTED_AT, grants.id))
			.limit(keysetFetchLimit(request.limit)),
		// FACETS (first page only): the scope predicates ONLY — one light pass over every grant in
		// the scope. It never sees `filterConditions` or the cursor; that is the invariant.
		firstPage
			? db
					.select({
						effect: grants.effect,
						resourceType: grants.resource_type,
						roleName: role.name,
						permissionKey: grants.permission_key,
					})
					.from(grants)
					.leftJoin(role, eq(grants.role_id, role.id))
					.where(and(...scopeConditions))
			: [],
	]);
	const cut = keysetPage(fetched, request.limit, (r) => ({ at: r.createdAt, id: r.id }));
	const rows = cut.rows.map((r): AccessGrantListRow => ({
		id: r.id,
		principalType: r.principalType,
		principalId: r.principalId,
		// A team grant renders its team NAME here (the unfiltered `listAccessGrants` shows a
		// truncated uuid because it never joined `team`), so the row shows what the search
		// matched on.
		principalLabel:
			r.teamName ??
			r.principalName ??
			r.principalEmail ??
			`${r.principalId.slice(0, 8)}…`,
		effect: r.effect === "deny" ? "deny" : "allow",
		roleName: r.roleName,
		permissionKey: r.permissionKey,
		resourceType: r.resourceType,
		resourceId: r.resourceId,
		createdAt: r.createdAt.toISOString(),
		asOf,
	}));
	const page = { rows, nextCursor: cut.nextCursor };
	if (!firstPage) return keysetListPage(page, null);

	const scopeCounts = tally(facetRows, (r) => r.resourceType);
	const roleCounts = tally(facetRows, (r) =>
		roleKey(r.roleName, r.permissionKey),
	);
	const effectCounts = tally(facetRows, (r) =>
		r.effect === "deny" ? "deny" : "allow",
	);

	return keysetListPage(page, {
		facets: {
			scopes: asOptions(scopeCounts),
			roles: asOptions(roleCounts, roleLabel),
			effects: orderedOptions(effectCounts, GRANT_EFFECTS),
		},
		universeEmpty: facetRows.length === 0,
	});
}
