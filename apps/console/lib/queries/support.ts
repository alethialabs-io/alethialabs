// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Typed query builders for support cases. All take the owner-scoped transaction from
// withOwnerScope (RLS is the tenancy wall); these are the visibility filters — most
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
}

/** Filters for {@link listCasesForOwner}. `status` buckets the lifecycle stages. */
export interface CaseListFilter {
	status?: "active" | "resolved";
}

/** The status values in each lifecycle bucket. */
const ACTIVE_STATUSES: SupportCaseStatus[] = [
	"open",
	"pending_support",
	"pending_customer",
];
const RESOLVED_STATUSES: SupportCaseStatus[] = ["resolved", "closed"];

/**
 * Lists the owner's cases, newest activity first, joined to the caller's read watermark
 * so each row carries an `unread` flag. Optionally filtered to the active or resolved
 * lifecycle bucket.
 */
export async function listCasesForOwner(
	tx: Tx,
	ownerId: string,
	filter: CaseListFilter = {},
): Promise<CaseListItem[]> {
	const statusFilter =
		filter.status === "active"
			? inArray(supportCases.status, ACTIVE_STATUSES)
			: filter.status === "resolved"
				? inArray(supportCases.status, RESOLVED_STATUSES)
				: undefined;

	const rows = await tx
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
		})
		.from(supportCases)
		.leftJoin(
			supportCaseReads,
			and(
				eq(supportCaseReads.case_id, supportCases.id),
				eq(supportCaseReads.user_id, ownerId),
			),
		)
		.where(statusFilter)
		.orderBy(desc(supportCases.last_message_at));

	return rows;
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
