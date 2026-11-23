// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Typed query builders for support cases. All take the scoped transaction from
// withSupportScope (tiered RLS is the tenancy + visibility wall — requester-own or, for
// manage_support holders, org-wide); these builders add the customer-facing filters — most
// importantly, the customer thread NEVER selects is_internal staff notes.

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { getServiceDb } from "@/lib/db";
import {
	type SupportCase,
	type SupportCaseAttachment,
	type SupportMessage,
	supportCaseAttachments,
	supportCaseReads,
	supportCases,
	supportMessages,
} from "@/lib/db/schema";
import type {
	SupportAuthorType,
	SupportCaseCategory,
	SupportCaseSeverity,
	SupportCaseStatus,
	SupportCaseType,
} from "@/lib/db/schema/enums";

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

/** Filters for {@link listCasesForOwner}. `status` buckets the lifecycle stages. */
export interface CaseListFilter {
	status?: "active" | "resolved";
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
 * Lists the owner's cases, newest activity first (ties broken by id, so the order is total),
 * joined to the caller's read watermark so each row carries an `unread` flag. Optionally
 * filtered to the active or resolved lifecycle bucket.
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
	const statusFilter =
		filter.status === "active"
			? inArray(supportCases.status, ACTIVE_STATUSES)
			: filter.status === "resolved"
				? inArray(supportCases.status, RESOLVED_STATUSES)
				: undefined;
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
		.where(and(statusFilter, afterCursor))
		.orderBy(desc(caseSortAt), desc(supportCases.id));

	return page ? listed.limit(page.limit) : listed;
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

