// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Typed query builders for support cases. All take the owner-scoped transaction from
// withOwnerScope (RLS is the tenancy wall); these are the visibility filters — most
// importantly, the customer thread NEVER selects is_internal staff notes.

import { and, asc, desc, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import type { getServiceDb } from "@/lib/db";
import {
	organization,
	type SupportCase,
	type SupportCaseAttachment,
	type SupportMessage,
	supportCaseAttachments,
	supportCaseReads,
	supportCases,
	supportMessages,
	user,
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

// ── Staff (cross-tenant) queries ────────────────────────────────────────────
// These run on getServiceDb() (RLS-bypass) — staff read EVERY org's cases; the
// SUPPORT_STAFF_EMAILS allowlist (lib/support/staff.ts) is the wall, not RLS. Unlike the
// customer queries they include is_internal notes and span all orgs.

/** A staff-list row: the customer fields plus org + assignee context. */
export interface StaffCaseListItem extends CaseListItem {
	org_id: string | null;
	org_name: string | null;
	org_slug: string | null;
	assigned_staff_id: string | null;
	assigned_staff_name: string | null;
}

/** Filters for {@link listCasesForStaff}. All optional; omitted = no constraint. */
export interface StaffCaseListFilter {
	/** A concrete lifecycle status (open, pending_support, resolved, …). */
	status?: SupportCaseStatus;
	severity?: SupportCaseSeverity;
	orgId?: string;
	/** Staff user id — the action passes its own id for the "assigned to me" filter. */
	assignedTo?: string;
	/** Case number (as text) or subject, ILIKE. */
	search?: string;
}

/**
 * Lists cases across ALL orgs for the staff dashboard, newest activity first. `unread` is
 * relative to the STAFF member's own read watermark. Joins the org (name/slug) and the
 * assignee's display name. Capped at 200 rows (the filter bar narrows further).
 */
export async function listCasesForStaff(
	db: Db,
	staffUserId: string,
	filter: StaffCaseListFilter = {},
): Promise<StaffCaseListItem[]> {
	const conds: SQL[] = [];
	if (filter.status) conds.push(eq(supportCases.status, filter.status));
	if (filter.severity) conds.push(eq(supportCases.severity, filter.severity));
	if (filter.orgId) conds.push(eq(supportCases.org_id, filter.orgId));
	if (filter.assignedTo)
		conds.push(eq(supportCases.assigned_staff_id, filter.assignedTo));
	if (filter.search?.trim()) {
		const q = `%${filter.search.trim()}%`;
		const bySubject = ilike(supportCases.subject, q);
		const byNumber = ilike(sql`${supportCases.case_number}::text`, q);
		const search = or(bySubject, byNumber);
		if (search) conds.push(search);
	}

	return db
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
			org_id: supportCases.org_id,
			org_name: organization.name,
			org_slug: organization.slug,
			assigned_staff_id: supportCases.assigned_staff_id,
			assigned_staff_name: user.name,
		})
		.from(supportCases)
		.leftJoin(organization, eq(organization.id, supportCases.org_id))
		.leftJoin(user, eq(user.id, supportCases.assigned_staff_id))
		.leftJoin(
			supportCaseReads,
			and(
				eq(supportCaseReads.case_id, supportCases.id),
				eq(supportCaseReads.user_id, staffUserId),
			),
		)
		.where(conds.length ? and(...conds) : undefined)
		.orderBy(desc(supportCases.last_message_at))
		.limit(200);
}

/** The staff-facing bundle for a case: full thread (incl. internal notes) + participants. */
export interface StaffCaseDetail {
	case: SupportCase;
	org_name: string | null;
	org_slug: string | null;
	customer_name: string | null;
	customer_email: string | null;
	assigned_staff_name: string | null;
	/** FULL thread — includes is_internal staff notes (staff see everything). */
	messages: SupportMessage[];
	attachments: SupportCaseAttachment[];
}

/**
 * Loads a case with its FULL thread (including is_internal staff notes) plus org, customer,
 * and assignee context, for the staff dashboard. Cross-tenant via getServiceDb.
 */
export async function getCaseWithThreadForStaff(
	db: Db,
	caseId: string,
): Promise<StaffCaseDetail | null> {
	const [caseRow] = await db
		.select()
		.from(supportCases)
		.where(eq(supportCases.id, caseId))
		.limit(1);
	if (!caseRow) return null;

	const [org] = caseRow.org_id
		? await db
				.select({ name: organization.name, slug: organization.slug })
				.from(organization)
				.where(eq(organization.id, caseRow.org_id))
				.limit(1)
		: [];

	const [customer] = await db
		.select({ name: user.name, email: user.email })
		.from(user)
		.where(eq(user.id, caseRow.user_id))
		.limit(1);

	const [assignee] = caseRow.assigned_staff_id
		? await db
				.select({ name: user.name })
				.from(user)
				.where(eq(user.id, caseRow.assigned_staff_id))
				.limit(1)
		: [];

	const messages = await db
		.select()
		.from(supportMessages)
		.where(eq(supportMessages.case_id, caseId))
		.orderBy(asc(supportMessages.created_at));

	const attachments = await db
		.select()
		.from(supportCaseAttachments)
		.where(eq(supportCaseAttachments.case_id, caseId));

	return {
		case: caseRow,
		org_name: org?.name ?? null,
		org_slug: org?.slug ?? null,
		customer_name: customer?.name ?? null,
		customer_email: customer?.email ?? null,
		assigned_staff_name: assignee?.name ?? null,
		messages,
		attachments,
	};
}
