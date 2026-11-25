// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Typed query builders for support cases. All take the scoped transaction from
// withSupportScope (tiered RLS is the tenancy + visibility wall — requester-own or, for
// manage_support holders, org-wide); these builders add the customer-facing filters — most
// importantly, the customer thread NEVER selects is_internal staff notes.

import { and, asc, count, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { getServiceDb } from "@/lib/db";
import { likeTerm } from "@/lib/db/like";
import {
	type SupportCase,
	type SupportCaseAttachment,
	type SupportMessage,
	supportCaseAttachments,
	supportCaseReads,
	supportCases,
	supportMessages,
} from "@/lib/db/schema";
import {
	type SupportAuthorType,
	type SupportCaseCategory,
	type SupportCaseSeverity,
	type SupportCaseStatus,
	type SupportCaseType,
	supportCaseSeverity,
	supportCaseType,
} from "@/lib/db/schema/enums";
import { type FacetOption, narrowTo, searchTerm } from "./facets";
import {
	type KeysetListPage,
	type KeysetPageRequest,
	type KeysetPosition,
	keysetAfter,
	keysetFetchLimit,
	keysetOrderBy,
	keysetPage,
	keysetSortKey,
} from "./keyset";

type Db = ReturnType<typeof getServiceDb>;
/** The owner-scoped transaction handed to a withOwnerScope/withScope callback. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A row in the "My cases" list — denormalized so it renders without a per-row join. */
export interface CaseListItem {
	id: string;
	case_number: number;
	subject: string;
	type: SupportCaseType;
	category: SupportCaseCategory;
	severity: SupportCaseSeverity;
	status: SupportCaseStatus;
	last_message_at: Date;
	last_author_type: SupportAuthorType;
	created_at: Date;
	/** True when there's a newer message than the caller's read watermark (or no watermark). */
	unread: boolean;
	/** Display name of whoever opened the case (the first customer message's author). */
	requester_name: string | null;
	/** True when the caller opened this case — lets admins' list hide the requester on their own rows. */
	is_mine: boolean;
}

/**
 * Filters for {@link listCasesForOwner}. `status` buckets the lifecycle stages; `search`, `severity`
 * and `type` are the list's filter bar (#7396). The two lists arrive as client strings and are
 * narrowed to the enum here, so a stale link's unknown value drops out rather than failing the read.
 */
export interface CaseListFilter {
	status?: "active" | "resolved";
	/** Free text over the subject, the `CASE-000123` reference and the bare number. */
	search?: string;
	/** `support_case_severity` values; empty or absent means every severity. */
	severity?: string[];
	/** `support_case_type` values; empty or absent means every type. */
	type?: string[];
}

/**
 * The cases list's facet options, counted over the caller's UNFILTERED cases. `label` is null: the
 * client owns the severity and type labels (`SUPPORT_SEVERITY_LABELS`, `SUPPORT_CASE_TYPE_LABELS`).
 */
export interface CaseFacets {
	severity: FacetOption[];
	type: FacetOption[];
}

/**
 * One page of the cases list, on the console list contract ({@link KeysetListPage}): its rows, the
 * cursor of the page after it, and — on the FIRST page only — the facets and the universe-empty
 * probe. A later page walks the same universe, so its counts would be identical.
 */
export type CasePage = KeysetListPage<CaseListItem, CaseFacets>;

/** The status values in each lifecycle bucket. */
const ACTIVE_STATUSES: SupportCaseStatus[] = [
	"open",
	"pending_support",
	"pending_customer",
];
const RESOLVED_STATUSES: SupportCaseStatus[] = ["resolved", "closed"];

/**
 * The list's sort key — latest activity, truncated to milliseconds by the shared codec
 * ({@link keysetSortKey}), so the ORDER BY and the cursor predicate read the same expression.
 */
const caseSortAt = keysetSortKey(supportCases.last_message_at);

/**
 * The case reference as `caseLabel` renders it (`CASE-` + the number zero-padded to six digits,
 * never truncated), so a search for "case-000123" finds the row the list shows as CASE-000123.
 */
const caseReference = sql`('CASE-' || repeat('0', greatest(0, 6 - length(${supportCases.case_number}::text))) || ${supportCases.case_number}::text)`;

/**
 * The filter predicates of {@link CaseListFilter}: the lifecycle bucket, the search term and the two
 * facets. Every one is a FILTER (the user picked it in the bar); the scope is RLS, which the
 * transaction already carries, so none of these may reach the facet pass.
 */
function caseFilterConditions(filter: CaseListFilter) {
	const statusFilter =
		filter.status === "active"
			? inArray(supportCases.status, ACTIVE_STATUSES)
			: filter.status === "resolved"
				? inArray(supportCases.status, RESOLVED_STATUSES)
				: undefined;
	const severity = narrowTo(supportCaseSeverity.enumValues, filter.severity);
	const type = narrowTo(supportCaseType.enumValues, filter.type);
	const search = searchTerm(filter.search);
	const like = search ? likeTerm(search) : undefined;
	return [
		statusFilter,
		severity ? inArray(supportCases.severity, severity) : undefined,
		type ? inArray(supportCases.type, type) : undefined,
		like
			? or(
					ilike(supportCases.subject, like),
					sql`${caseReference} ilike ${like}`,
					sql`${supportCases.case_number}::text ilike ${like}`,
				)
			: undefined,
	];
}

/**
 * The rows pass of the cases list: the owner's cases, newest activity first (ties broken by id, so
 * the order is total — {@link keysetOrderBy}), joined to the caller's read watermark so each row
 * carries an `unread` flag, under every filter of {@link CaseListFilter} and, with `cursor`, only
 * the rows strictly after it ({@link keysetAfter}) — so a case can neither be skipped nor repeated at
 * a page boundary, even among cases whose latest message shares a timestamp.
 */
function selectCases(tx: Tx, ownerId: string, filter: CaseListFilter, cursor?: KeysetPosition) {
	return tx
		.select({
			id: supportCases.id,
			case_number: supportCases.case_number,
			subject: supportCases.subject,
			type: supportCases.type,
			category: supportCases.category,
			severity: supportCases.severity,
			status: supportCases.status,
			last_message_at: supportCases.last_message_at,
			last_author_type: supportCases.last_author_type,
			created_at: supportCases.created_at,
			unread: sql<boolean>`(${supportCaseReads.last_read_at} is null or ${supportCases.last_message_at} > ${supportCaseReads.last_read_at})`,
			// Requester = author of the case's first customer message (stays within the
			// RLS-visible support tables, so no cross-user user/profiles join is needed).
			requester_name: sql<
				string | null
			>`(select am.author_name from ${supportMessages} am where am.case_id = ${supportCases.id} and am.author_type = 'customer' order by am.created_at asc limit 1)`,
			is_mine: sql<boolean>`(${supportCases.user_id} = ${ownerId})`,
		})
		.from(supportCases)
		.leftJoin(
			supportCaseReads,
			and(
				eq(supportCaseReads.case_id, supportCases.id),
				eq(supportCaseReads.user_id, ownerId),
			),
		)
		.where(and(...caseFilterConditions(filter), keysetAfter(caseSortAt, supportCases.id, cursor)))
		.orderBy(...keysetOrderBy(caseSortAt, supportCases.id));
}

/**
 * Lists EVERY one of the owner's cases under `filter`, in the list's order — the shell bell's feed
 * (`workspace.supportCases`) reads it this way. The "My cases" list pages through
 * {@link queryCasesPage} instead.
 */
export async function listCasesForOwner(
	tx: Tx,
	ownerId: string,
	filter: CaseListFilter = {},
): Promise<CaseListItem[]> {
	return selectCases(tx, ownerId, filter);
}

/**
 * The facet pass: one GROUP BY over the caller's cases, with NO filter predicate — only the scope,
 * which is the transaction's RLS (requester-own, or org-wide for a `manage_support` holder). So an
 * option's count is the same whatever the bar has selected, and selecting it cannot make it vanish.
 */
async function caseFacetsForOwner(tx: Tx): Promise<CaseFacets> {
	const groups = await tx
		.select({ severity: supportCases.severity, type: supportCases.type, n: count() })
		.from(supportCases)
		.groupBy(supportCases.severity, supportCases.type);
	const counted = (key: "severity" | "type"): FacetOption[] => {
		const totals = new Map<string, number>();
		for (const g of groups) totals.set(g[key], (totals.get(g[key]) ?? 0) + Number(g.n));
		return [...totals].map(([value, n]) => ({ value, label: null, count: n }));
	};
	return { severity: counted("severity"), type: counted("type") };
}

/**
 * The cases list's read — a `query<Thing>Page` builder on the console list contract
 * (lib/query/README.md → "Paging" and "Server-side filters"): a filtered ROWS pass with every filter
 * and the keyset cursor, reading `limit + 1` rows so the end is known exactly
 * ({@link keysetFetchLimit}), and, on the first page, a separate FACET pass over the unfiltered scope
 * ({@link caseFacetsForOwner}). The two run one after the other because they share the scoped
 * transaction (one connection).
 *
 * `universeEmpty` is read off the facet pass: every case carries a severity, so no severity option
 * means no case in scope at all (the first-run empty state), never a filtered one.
 */
export async function queryCasesPage(
	tx: Tx,
	ownerId: string,
	filter: CaseListFilter,
	page: KeysetPageRequest,
): Promise<CasePage> {
	const fetched = await selectCases(tx, ownerId, filter, page.cursor).limit(keysetFetchLimit(page.limit));
	const { rows, nextCursor } = keysetPage(fetched, page.limit, (row) => ({ at: row.last_message_at, id: row.id }));
	if (page.cursor) return { rows, nextCursor, facets: null, universeEmpty: null };
	const facets = await caseFacetsForOwner(tx);
	return { rows, nextCursor, facets, universeEmpty: facets.severity.length === 0 };
}

/** A thread message safe to return to the customer — the internal-note flag is stripped. */
export type PublicMessage = Omit<SupportMessage, "is_internal">;

/** The customer-facing bundle for a single case: the case, its public thread, and attachments. */
export interface CaseWithThread {
	case: SupportCase;
	messages: PublicMessage[];
	attachments: SupportCaseAttachment[];
}

/**
 * Loads one case with its customer-visible thread (is_internal notes excluded) and its
 * attachments, or null when the case doesn't exist / isn't visible under the caller's
 * RLS scope. Messages are ordered oldest-first for a natural conversation read.
 */
export async function getCaseWithThread(
	tx: Tx,
	caseId: string,
): Promise<CaseWithThread | null> {
	const [caseRow] = await tx
		.select()
		.from(supportCases)
		.where(eq(supportCases.id, caseId))
		.limit(1);
	if (!caseRow) return null;

	const messages = await tx
		.select({
			id: supportMessages.id,
			case_id: supportMessages.case_id,
			author_type: supportMessages.author_type,
			author_id: supportMessages.author_id,
			author_name: supportMessages.author_name,
			body: supportMessages.body,
			created_at: supportMessages.created_at,
		})
		.from(supportMessages)
		.where(
			and(
				eq(supportMessages.case_id, caseId),
				eq(supportMessages.is_internal, false),
			),
		)
		.orderBy(asc(supportMessages.created_at));

	const attachments = await tx
		.select()
		.from(supportCaseAttachments)
		.where(eq(supportCaseAttachments.case_id, caseId));

	return { case: caseRow, messages, attachments };
}

