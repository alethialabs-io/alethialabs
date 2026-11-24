// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Typed query builders for support cases. All take the scoped transaction from
// withSupportScope (tiered RLS is the tenancy + visibility wall — requester-own or, for
// manage_support holders, org-wide); these builders add the customer-facing filters — most
// importantly, the customer thread NEVER selects is_internal staff notes.

import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
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
 * One page of the cases list: its rows, and — on the FIRST page only — the facets. A later page
 * walks the same universe, so its counts would be identical (the Activity log's rule).
 */
export interface CasePage {
	rows: CaseListItem[];
	facets: CaseFacets | null;
}

/**
 * A keyset position in the case list: the last row a page returned, by the list's own sort key.
 * `at` is that row's `last_message_at` as an ISO string (millisecond precision — what a JS `Date`
 * carries), `id` its case id, the tiebreaker that makes the key total.
 */
export interface CaseCursor {
	at: string;
	id: string;
}

/** One page request for {@link listCasesForOwner}: rows strictly after `cursor`, at most `limit`. */
export interface CasePageRequest {
	cursor?: CaseCursor;
	limit: number;
}

/** How many cases one page of the "My cases" list carries. */
export const CASE_PAGE_SIZE = 50;

/**
 * The cursor to request the page after `page`, or null when `page` is the last one. A page shorter
 * than `limit` is the end; a full page may be followed by more (or by an empty page, when the total
 * is an exact multiple — one wasted read, never a dropped case).
 */
export function nextCaseCursor(
	page: readonly Pick<CaseListItem, "id" | "last_message_at">[],
	limit: number = CASE_PAGE_SIZE,
): CaseCursor | null {
	const last = page.at(-1);
	if (last === undefined || page.length < limit) return null;
	return { at: new Date(last.last_message_at).toISOString(), id: last.id };
}

/** The status values in each lifecycle bucket. */
const ACTIVE_STATUSES: SupportCaseStatus[] = [
	"open",
	"pending_support",
	"pending_customer",
];
const RESOLVED_STATUSES: SupportCaseStatus[] = ["resolved", "closed"];

/**
 * The list's sort key, truncated to milliseconds. Postgres keeps microseconds but a cursor travels
 * as a JS `Date` (milliseconds), so ordering and comparing on the raw column would let a row in the
 * same millisecond as the cursor, but a later microsecond, fall on the wrong side of it — skipped.
 * Ordering and the cursor predicate both read THIS expression, so they cannot disagree.
 */
const caseSortAt = sql`date_trunc('milliseconds', ${supportCases.last_message_at})`;

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
 * Lists the owner's cases, newest activity first (ties broken by id, so the order is total),
 * joined to the caller's read watermark so each row carries an `unread` flag. Optionally
 * filtered to the active or resolved lifecycle bucket, and by the list's search, severity and type.
 *
 * With `page`, returns at most `page.limit` rows strictly after `page.cursor` by that same
 * (activity, id) key — keyset paging, so a case can neither be skipped nor repeated at a page
 * boundary, even among cases whose latest message shares a timestamp. Without `page`, every
 * case (the shell bell's feed reads it that way).
 */
export async function listCasesForOwner(
	tx: Tx,
	ownerId: string,
	filter: CaseListFilter = {},
	page?: CasePageRequest,
): Promise<CaseListItem[]> {
	const cursor = page?.cursor;
	const afterCursor = cursor
		? sql`(${caseSortAt}, ${supportCases.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
		: undefined;

	const listed = tx
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
		.where(and(...caseFilterConditions(filter), afterCursor))
		.orderBy(desc(caseSortAt), desc(supportCases.id));

	return page ? listed.limit(page.limit) : listed;
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
 * The cases list's read, on the console filter standard's server half (lib/query/README.md, step 6):
 * a filtered ROWS pass — {@link listCasesForOwner} with every filter and the keyset cursor — and, on
 * the first page, a separate FACET pass over the unfiltered scope ({@link caseFacetsForOwner}). The
 * two run one after the other because they share the scoped transaction (one connection).
 */
export async function queryCasesPage(
	tx: Tx,
	ownerId: string,
	filter: CaseListFilter,
	page: CasePageRequest,
): Promise<CasePage> {
	const rows = await listCasesForOwner(tx, ownerId, filter, page);
	const facets = page.cursor ? null : await caseFacetsForOwner(tx);
	return { rows, facets };
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

