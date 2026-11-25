// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// The service tokens list's read (AGT-L2-U3, gap G11), on the console list standard
// (lib/query/README.md, "Paging" and "Server-side filters"): a filtered ROWS pass with a keyset
// cursor, and on the first page a separate FACET pass over the UNFILTERED universe, which sees only
// the scope predicate — the org. So a status option's count stays put whatever the bar has selected.
//
// SCOPE. `cli_service_tokens` is read on the service role, as the CLI's token routes read it, so the
// org predicate here IS the tenancy boundary: it is in both passes and in every name lookup below.
//
// STATUS IS DERIVED, in SQL for the filter and the facet (`revoked_at`, then `expires_at` against the
// database clock) and in JS for the row (`serviceTokenStatus`, against the request's clock). The two
// clocks can disagree for the instant a token crosses its expiry; the next read agrees again.
//
// PAGING is the shared keyset contract (lib/queries/keyset.ts): `(created_at, id)`, newest first,
// millisecond-truncated, an opaque cursor, and an exact `nextCursor` from reading one row more.

import { and, count, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import { type ConsoleServiceToken, serviceTokenStatus } from "@/lib/agents/service-tokens";
import { getServiceDb } from "@/lib/db";
import { likeTerm } from "@/lib/db/like";
import { cliServiceTokens, projectEnvironments, projects, user } from "@/lib/db/schema";
import type { EnvironmentStage } from "@/lib/db/schema/enums";
import { type FacetOption, narrowTo, orderedOptions, searchTerm } from "./facets";
import {
	type KeysetListPage,
	type KeysetPageRequest,
	keysetAfter,
	keysetFetchLimit,
	keysetListPage,
	keysetOrderBy,
	keysetPage,
	keysetSortKey,
} from "./keyset";

/** The token states the Status facet offers, in its fixed order. */
const SERVICE_TOKEN_STATUSES = ["active", "expired", "revoked"] as const;

/** The list's filters. Every list arrives as client strings and is narrowed here. */
export interface ServiceTokenListFilter {
	/** Token states (`SERVICE_TOKEN_STATUSES`). */
	status?: string[];
	/** Free text over the token's name and its prefix. */
	search?: string;
}

/** A project a token is limited to, named. */
interface ServiceTokenProjectRef {
	id: string;
	name: string;
}

/** An environment a token deploys to without a person, named as the list and the sheet show it. */
export interface ServiceTokenEnvironmentRef {
	id: string;
	name: string;
	projectId: string;
	projectName: string;
	stage: EnvironmentStage;
}

/** One row of the service tokens list: the token, with its projects and environments named. */
export interface ServiceTokenListItem extends ConsoleServiceToken {
	/** The projects it is limited to, by name; null means every project of the org. */
	projects: ServiceTokenProjectRef[] | null;
	/** Its auto-approve environments that still exist, by name, in project then environment order. */
	autoApproveEnvironments: ServiceTokenEnvironmentRef[];
}

/** The list's facet options over the unfiltered universe. Labels are the client's. */
export interface ServiceTokenFacets {
	status: FacetOption[];
}

/** One page of the list, in the shared keyset shape; facets and `universeEmpty` on the first page only. */
export type ServiceTokenPage = KeysetListPage<ServiceTokenListItem, ServiceTokenFacets>;

/** The sort key, truncated to the millisecond a cursor carries. */
const sortAt = keysetSortKey(cliServiceTokens.created_at);

/** The derived state as SQL: revoked wins over expired, as in `serviceTokenStatus`. */
const derivedStatus = sql<string>`(case when ${cliServiceTokens.revoked_at} is not null then 'revoked' when ${cliServiceTokens.expires_at} is not null and ${cliServiceTokens.expires_at} <= now() then 'expired' else 'active' end)`;

/** The scope predicate: the org. Shared by both passes. */
function scopeCondition(orgId: string): SQL {
	return eq(cliServiceTokens.organization_id, orgId);
}

/** The filter predicates. FILTERS only — none of these may reach the facet pass. */
function filterConditions(filter: ServiceTokenListFilter): (SQL | undefined)[] {
	const status = narrowTo(SERVICE_TOKEN_STATUSES, filter.status);
	const search = searchTerm(filter.search);
	const like = search ? likeTerm(search) : undefined;
	return [
		status ? inArray(derivedStatus, status) : undefined,
		like ? or(ilike(cliServiceTokens.name, like), ilike(cliServiceTokens.token_prefix, like)) : undefined,
	];
}

/**
 * The project and environment names a page's rows name, read for exactly those ids and bound to the
 * org, so an id that left the org (or never belonged to it) names nothing.
 */
async function namesFor(
	orgId: string,
	projectIds: readonly string[],
	environmentIds: readonly string[],
): Promise<{ projects: Map<string, string>; environments: Map<string, ServiceTokenEnvironmentRef> }> {
	const db = getServiceDb();
	const [projectRows, environmentRows] = await Promise.all([
		projectIds.length
			? db
					.select({ id: projects.id, name: projects.project_name })
					.from(projects)
					.where(and(eq(projects.org_id, orgId), inArray(projects.id, [...projectIds])))
			: [],
		environmentIds.length
			? db
					.select({
						id: projectEnvironments.id,
						name: projectEnvironments.name,
						projectId: projects.id,
						projectName: projects.project_name,
						stage: projectEnvironments.stage,
					})
					.from(projectEnvironments)
					.innerJoin(projects, eq(projects.id, projectEnvironments.project_id))
					.where(and(eq(projects.org_id, orgId), inArray(projectEnvironments.id, [...environmentIds])))
			: [],
	]);
	return {
		projects: new Map(projectRows.map((p) => [p.id, p.name])),
		environments: new Map(environmentRows.map((e) => [e.id, e])),
	};
}

/** The rows pass: one keyset page under every filter, newest first, as list items. */
async function listServiceTokens(
	orgId: string,
	filter: ServiceTokenListFilter,
	page: KeysetPageRequest,
	now: Date,
): Promise<{ rows: ServiceTokenListItem[]; nextCursor: string | null }> {
	const fetched = await getServiceDb()
		.select({
			id: cliServiceTokens.id,
			name: cliServiceTokens.name,
			token_prefix: cliServiceTokens.token_prefix,
			scopes: cliServiceTokens.scopes,
			project_ids: cliServiceTokens.project_ids,
			auto_approve_environment_ids: cliServiceTokens.auto_approve_environment_ids,
			created_at: cliServiceTokens.created_at,
			created_by: cliServiceTokens.created_by,
			creator_name: user.name,
			expires_at: cliServiceTokens.expires_at,
			last_used_at: cliServiceTokens.last_used_at,
			revoked_at: cliServiceTokens.revoked_at,
		})
		.from(cliServiceTokens)
		.leftJoin(user, eq(user.id, cliServiceTokens.created_by))
		.where(
			and(
				scopeCondition(orgId),
				...filterConditions(filter),
				keysetAfter(sortAt, cliServiceTokens.id, page.cursor),
			),
		)
		.orderBy(...keysetOrderBy(sortAt, cliServiceTokens.id))
		.limit(keysetFetchLimit(page.limit));
	const { rows, nextCursor } = keysetPage(fetched, page.limit, (r) => ({ at: r.created_at, id: r.id }));

	const names = await namesFor(
		orgId,
		[...new Set(rows.flatMap((r) => r.project_ids ?? []))],
		[...new Set(rows.flatMap((r) => r.auto_approve_environment_ids))],
	);
	const items = rows.map((r): ServiceTokenListItem => ({
		id: r.id,
		name: r.name,
		tokenPrefix: r.token_prefix,
		scopes: r.scopes,
		projectIds: r.project_ids,
		autoApproveEnvironmentIds: r.auto_approve_environment_ids,
		createdAt: r.created_at.toISOString(),
		createdBy: r.created_by ? { id: r.created_by, name: r.creator_name } : null,
		expiresAt: r.expires_at?.toISOString() ?? null,
		lastUsedAt: r.last_used_at?.toISOString() ?? null,
		revokedAt: r.revoked_at?.toISOString() ?? null,
		status: serviceTokenStatus(r, now),
		projects: r.project_ids
			? r.project_ids.flatMap((id) => {
					const name = names.projects.get(id);
					return name === undefined ? [] : [{ id, name }];
				})
			: null,
		autoApproveEnvironments: r.auto_approve_environment_ids
			.flatMap((id) => {
				const env = names.environments.get(id);
				return env ? [env] : [];
			})
			.sort((a, b) => a.projectName.localeCompare(b.projectName) || a.name.localeCompare(b.name)),
	}));
	return { rows: items, nextCursor };
}

/**
 * The facet pass: one GROUP BY over the scope only (the org), never the filters, so selecting an
 * option cannot make it vanish. The three states come back in their fixed order, zeros included.
 */
async function serviceTokenFacets(orgId: string): Promise<ServiceTokenFacets> {
	const groups = await getServiceDb()
		.select({ status: derivedStatus, n: count() })
		.from(cliServiceTokens)
		.where(scopeCondition(orgId))
		.groupBy(derivedStatus);
	const totals = new Map<string, number>();
	for (const g of groups) totals.set(g.status, (totals.get(g.status) ?? 0) + Number(g.n));
	return { status: orderedOptions(totals, SERVICE_TOKEN_STATUSES) };
}

/**
 * One page of the org's service tokens, revoked and expired ones included (their audit trail
 * matters): the filtered rows pass and, on the first page only (a later page walks the same
 * universe), the facet pass and whether the org holds any token at all.
 */
export async function queryServiceTokensPage(
	orgId: string,
	filter: ServiceTokenListFilter,
	page: KeysetPageRequest,
	now: Date = new Date(),
): Promise<ServiceTokenPage> {
	const cut = await listServiceTokens(orgId, filter, page, now);
	if (page.cursor) return keysetListPage(cut, null);
	const facets = await serviceTokenFacets(orgId);
	const universeEmpty = facets.status.every((o) => o.count === 0);
	return keysetListPage(cut, { facets, universeEmpty });
}
