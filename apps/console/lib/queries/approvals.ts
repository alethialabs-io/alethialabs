// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The approvals list's read (AGT-L2, gap G2), on the console filter standard's server half
// (lib/query/README.md, step 6; the support cases list is the reference): a filtered ROWS pass with a
// keyset cursor, and on the first page a separate FACET pass over the UNFILTERED universe, which sees
// only the scope predicates — the org (RLS on the scoped transaction, and named) and the projects the
// viewer may `view`. So an option's count stays put whatever the bar has selected.
//
// STATUS IS THE EFFECTIVE ONE, in SQL where SQL can say it: a `pending` or `approved` row past its
// `expires_at` reads `expired` in the filter, the facet and the row. `superseded` needs the plan
// binding (binding.ts), which is not a column; the rows pass applies it per row (`viewOf`), so a row
// whose plan moved reads `superseded` on screen while it still counts under its stored status in the
// filter and the facet until it is decided or used (both mark the row).
//
// PAGING is the shared keyset contract (lib/queries/keyset.ts): `(created_at, id)`, newest first,
// millisecond-truncated, an opaque cursor, and an exact `nextCursor` from reading one row more.

import { and, count, eq, ilike, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import { viewOf } from "@/lib/approvals/read";
import { APPROVAL_STATUSES, type ApplyOperation, type ApprovalStatus } from "@/lib/approvals/types";
import type { CredentialKind } from "@/lib/authz/types";
import type { Tx } from "@/lib/db";
import { getServiceDb } from "@/lib/db";
import { likeTerm } from "@/lib/db/like";
import {
	applyApprovals,
	cliServiceTokens,
	oauthClient,
	projectEnvironments,
	projects,
	user,
} from "@/lib/db/schema";
import type { ApplyApproval } from "@/lib/db/schema/agent-surface";
import { actorCredential, approvalOperation, type EnvironmentStage } from "@/lib/db/schema/enums";
import { type FacetOption, narrowTo, nonEmpty, orderedOptions, searchTerm } from "./facets";
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

/** The list's filters. Every list arrives as client strings and is narrowed here. */
export interface ApprovalListFilter {
	/** Effective statuses (`APPROVAL_STATUSES`). */
	status?: string[];
	/** `deploy` / `destroy`. */
	operation?: string[];
	/** Requested through: the requester's credential kind. */
	credential?: string[];
	/** Environment ids. */
	environment?: string[];
	/** Free text over the project name, the environment name and the digest prefix. */
	search?: string;
}

/** One row of the approvals list: the approval's effective view, joined to what the row shows. */
export interface ApprovalListItem {
	id: string;
	status: ApprovalStatus;
	operation: ApplyOperation;
	project_id: string;
	project_name: string;
	environment_id: string;
	environment_name: string;
	environment_stage: EnvironmentStage;
	plan_job_id: string;
	digest_prefix: string;
	requester_user_id: string;
	requester_name: string | null;
	requester_credential: CredentialKind;
	/** The service token's name, or the OAuth client's name, when the credential names one. */
	requester_credential_name: string | null;
	/** The raw credential reference (token id, or OAuth client id) the name was read from. */
	requester_credential_ref: string | null;
	/**
	 * The icon the OAuth client registered in its own metadata document, for a connected agent; null
	 * for every other credential. Drawn only for an app the agent catalogue does not know.
	 */
	requester_credential_icon: string | null;
	created_at: string;
	expires_at: string;
	decided_at: string | null;
	approver_user_id: string | null;
	approver_name: string | null;
	consumed_job_id: string | null;
}

/** The list's facet options over the unfiltered universe. Labels are the client's, except environments'. */
export interface ApprovalFacets {
	status: FacetOption[];
	operation: FacetOption[];
	credential: FacetOption[];
	environment: FacetOption[];
}

/** One page of the list, in the shared keyset shape; facets and `universeEmpty` on the first page only. */
export type ApprovalPage = KeysetListPage<ApprovalListItem, ApprovalFacets>;

/** The sort key, truncated to the millisecond a cursor carries. */
const sortAt = keysetSortKey(applyApprovals.created_at);

/** The effective status as SQL: a live row past its expiry reads `expired`. */
const effectiveStatus = sql<string>`(case when ${applyApprovals.status} in ('pending', 'approved') and ${applyApprovals.expires_at} <= now() then 'expired' else ${applyApprovals.status}::text end)`;

/** The scope predicates: the org, and the projects the viewer may view. Shared by both passes. */
function scopeConditions(orgId: string, projectIds: readonly string[]): SQL[] {
	return [eq(applyApprovals.org_id, orgId), inArray(applyApprovals.project_id, [...projectIds])];
}

/** The filter predicates. FILTERS only — none of these may reach the facet pass. */
function filterConditions(filter: ApprovalListFilter): (SQL | undefined)[] {
	const status = narrowTo(APPROVAL_STATUSES, filter.status);
	const operation = narrowTo(approvalOperation.enumValues, filter.operation);
	const credential = narrowTo(actorCredential.enumValues, filter.credential);
	const environment = nonEmpty(filter.environment)?.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
	const search = searchTerm(filter.search);
	const like = search ? likeTerm(search) : undefined;
	return [
		status ? inArray(effectiveStatus, status) : undefined,
		operation ? inArray(applyApprovals.operation, operation) : undefined,
		credential ? inArray(applyApprovals.requester_credential, credential) : undefined,
		environment?.length ? inArray(applyApprovals.environment_id, environment) : undefined,
		like
			? or(
					ilike(projects.project_name, like),
					ilike(projectEnvironments.name, like),
					sql`left(${applyApprovals.plan_sha256}, 8) ilike ${like}`,
				)
			: undefined,
	];
}

/** Names for the people and credentials a page's rows name, read for exactly those ids. */
interface Names {
	users: Map<string, string | null>;
	tokens: Map<string, string>;
	clients: Map<string, { name: string | null; icon: string | null }>;
}

/**
 * The display names a page needs. Read on the service role for exactly the ids the scoped rows pass
 * returned — every id here already passed the org and project scope — and the token lookup is bound
 * to the org as well.
 */
async function namesFor(orgId: string, rows: readonly ApplyApproval[]): Promise<Names> {
	const userIds = [
		...new Set(rows.flatMap((r) => [r.requester_user_id, r.approver_user_id]).filter((id): id is string => !!id)),
	];
	const tokenIds = [
		...new Set(rows.filter((r) => r.requester_credential === "service_token" && r.requester_credential_ref).map((r) => r.requester_credential_ref ?? "")),
	].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
	const clientIds = [
		...new Set(rows.filter((r) => r.requester_credential === "agent_oauth" && r.requester_credential_ref).map((r) => r.requester_credential_ref ?? "")),
	];
	const db = getServiceDb();
	const [users, tokens, clients] = await Promise.all([
		userIds.length ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds)) : [],
		tokenIds.length
			? db
					.select({ id: cliServiceTokens.id, name: cliServiceTokens.name })
					.from(cliServiceTokens)
					.where(and(inArray(cliServiceTokens.id, tokenIds), eq(cliServiceTokens.organization_id, orgId)))
			: [],
		clientIds.length
			? db
					.select({ id: oauthClient.clientId, name: oauthClient.name, icon: oauthClient.icon })
					.from(oauthClient)
					.where(inArray(oauthClient.clientId, clientIds))
			: [],
	]);
	return {
		users: new Map(users.map((u) => [u.id, u.name])),
		tokens: new Map(tokens.map((t) => [t.id, t.name])),
		clients: new Map(clients.map((c) => [c.id, { name: c.name, icon: c.icon }])),
	};
}

/** The rows pass: one keyset page under every filter, newest first, as list items. */
async function listApprovals(
	tx: Tx,
	orgId: string,
	projectIds: readonly string[],
	filter: ApprovalListFilter,
	page: KeysetPageRequest,
	now: Date,
	only?: SQL,
): Promise<{ rows: ApprovalListItem[]; nextCursor: string | null }> {
	const afterCursor = keysetAfter(sortAt, applyApprovals.id, page.cursor);
	const fetched = await tx
		.select({
			approval: applyApprovals,
			project_name: projects.project_name,
			environment_name: projectEnvironments.name,
			environment_stage: projectEnvironments.stage,
		})
		.from(applyApprovals)
		.innerJoin(projects, eq(projects.id, applyApprovals.project_id))
		.innerJoin(projectEnvironments, eq(projectEnvironments.id, applyApprovals.environment_id))
		.where(and(...scopeConditions(orgId, projectIds), ...filterConditions(filter), afterCursor, only))
		.orderBy(...keysetOrderBy(sortAt, applyApprovals.id))
		.limit(keysetFetchLimit(page.limit));
	const { rows, nextCursor } = keysetPage(fetched, page.limit, (r) => ({ at: r.approval.created_at, id: r.approval.id }));

	const names = await namesFor(orgId, rows.map((r) => r.approval));
	const items: ApprovalListItem[] = [];
	for (const row of rows) {
		const a = row.approval;
		const view = await viewOf(tx, a, now);
		const ref = a.requester_credential_ref;
		const credentialName =
			ref === null
				? null
				: a.requester_credential === "service_token"
					? (names.tokens.get(ref) ?? null)
					: a.requester_credential === "agent_oauth"
						? (names.clients.get(ref)?.name ?? null)
						: null;
		const credentialIcon = ref !== null && a.requester_credential === "agent_oauth" ? (names.clients.get(ref)?.icon ?? null) : null;
		items.push({
			id: a.id,
			status: view.status,
			operation: a.operation,
			project_id: a.project_id,
			project_name: row.project_name,
			environment_id: a.environment_id,
			environment_name: row.environment_name,
			environment_stage: row.environment_stage,
			plan_job_id: a.plan_job_id,
			digest_prefix: view.digest_prefix,
			requester_user_id: a.requester_user_id,
			requester_name: names.users.get(a.requester_user_id) ?? null,
			requester_credential: a.requester_credential,
			requester_credential_name: credentialName,
			requester_credential_ref: ref,
			requester_credential_icon: credentialIcon,
			created_at: a.created_at.toISOString(),
			expires_at: view.expires_at,
			decided_at: view.decided_at,
			approver_user_id: a.approver_user_id,
			approver_name: a.approver_user_id ? (names.users.get(a.approver_user_id) ?? null) : null,
			consumed_job_id: a.consumed_job_id,
		});
	}
	return { rows: items, nextCursor };
}

/**
 * The facet pass: GROUP BYs over the scope only (org + viewable projects), never the filters, so
 * selecting an option cannot make it vanish. Statuses and operations come back in their fixed order,
 * zeros included; credentials and environments only where the universe has them.
 */
async function approvalFacets(tx: Tx, orgId: string, projectIds: readonly string[]): Promise<ApprovalFacets> {
	const scope = and(...scopeConditions(orgId, projectIds));
	const groups = await tx
		.select({
			status: effectiveStatus,
			operation: applyApprovals.operation,
			credential: applyApprovals.requester_credential,
			n: count(),
		})
		.from(applyApprovals)
		.where(scope)
		.groupBy(effectiveStatus, applyApprovals.operation, applyApprovals.requester_credential);
	const envs = await tx
		.select({
			id: applyApprovals.environment_id,
			name: projectEnvironments.name,
			project: projects.project_name,
			n: count(),
		})
		.from(applyApprovals)
		.innerJoin(projectEnvironments, eq(projectEnvironments.id, applyApprovals.environment_id))
		.innerJoin(projects, eq(projects.id, applyApprovals.project_id))
		.where(and(scope, isNotNull(applyApprovals.environment_id)))
		.groupBy(applyApprovals.environment_id, projectEnvironments.name, projects.project_name);

	const totals = (key: "status" | "operation" | "credential"): Map<string, number> => {
		const out = new Map<string, number>();
		for (const g of groups) out.set(g[key], (out.get(g[key]) ?? 0) + Number(g.n));
		return out;
	};
	const credentials = totals("credential");
	return {
		status: orderedOptions(totals("status"), APPROVAL_STATUSES),
		operation: orderedOptions(totals("operation"), approvalOperation.enumValues),
		credential: actorCredential.enumValues
			.filter((c) => credentials.has(c))
			.map((c) => ({ value: c, label: null, count: credentials.get(c) ?? 0 })),
		environment: envs
			.map((e) => ({ value: e.id, label: `${e.project} / ${e.name}`, count: Number(e.n) }))
			.sort((a, b) => a.label.localeCompare(b.label)),
	};
}

/** The facets of a universe with nothing in it: every fixed option at zero, no environments. */
function emptyFacets(): ApprovalFacets {
	return {
		status: orderedOptions(new Map(), APPROVAL_STATUSES),
		operation: orderedOptions(new Map(), approvalOperation.enumValues),
		credential: [],
		environment: [],
	};
}

/**
 * One page of the approvals list for a viewer in `orgId` who may view `projectIds`: the filtered rows
 * pass and, on the first page only (a later page walks the same universe), the facet pass and whether
 * the scope holds anything at all. `tx` is the viewer's scoped transaction (`withActorScope`), so RLS
 * bounds both passes to the org as well. A viewer who may view no project reads nothing.
 */
export async function queryApprovalsPage(
	tx: Tx,
	orgId: string,
	projectIds: readonly string[],
	filter: ApprovalListFilter,
	page: KeysetPageRequest,
	now: Date = new Date(),
): Promise<ApprovalPage> {
	if (projectIds.length === 0) {
		return keysetListPage({ rows: [], nextCursor: null }, page.cursor ? null : { facets: emptyFacets(), universeEmpty: true });
	}
	const cut = await listApprovals(tx, orgId, projectIds, filter, page, now);
	if (page.cursor) return keysetListPage(cut, null);
	const facets = await approvalFacets(tx, orgId, projectIds);
	const universeEmpty = facets.status.every((o) => o.count === 0);
	return keysetListPage(cut, { facets, universeEmpty });
}

/** One approval as a list item plus what only the decision sheet shows. */
export interface ApprovalDetail extends ApprovalListItem {
	/** The requester's note. UNTRUSTED text (at most 500 characters), rendered as data. */
	note: string | null;
	/** The decider's reason for denying, when they gave one. UNTRUSTED text. */
	decision_reason: string | null;
}

/**
 * Approval `id` as the decision sheet reads it, or null when it is not in `orgId` or its project is
 * not one of `projectIds` — a missing approval and one the viewer may not see read the same.
 */
export async function readApprovalDetail(
	tx: Tx,
	orgId: string,
	projectIds: readonly string[],
	id: string,
	now: Date = new Date(),
): Promise<ApprovalDetail | null> {
	if (projectIds.length === 0) return null;
	const {
		rows: [item],
	} = await listApprovals(tx, orgId, projectIds, {}, { limit: 1 }, now, eq(applyApprovals.id, id));
	if (!item) return null;
	const [extra] = await tx
		.select({ note: applyApprovals.reason, decision_reason: applyApprovals.decision_reason })
		.from(applyApprovals)
		.where(and(eq(applyApprovals.id, id), eq(applyApprovals.org_id, orgId)))
		.limit(1);
	return { ...item, note: extra?.note ?? null, decision_reason: extra?.decision_reason ?? null };
}
