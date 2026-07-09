// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Staff (cross-tenant) query builders for support cases. These run on getServiceDb()
// (RLS-bypass) — staff read EVERY org's cases; the SUPPORT_STAFF_EMAILS allowlist (behind
// Cloudflare Access) is the wall, not RLS. Unlike the console's customer query builders
// these include is_internal staff notes and span all orgs.

import { and, asc, desc, eq, gte, ilike, lt, or, type SQL, sql } from "drizzle-orm";
import {
	type SupportCase,
	type SupportCaseAttachment,
	type SupportMessage,
	supportCaseAttachments,
	supportCaseReads,
	supportCases,
	supportMessages,
} from "@repo/support/schema";
import type {
	SupportAuthorType,
	SupportCaseCategory,
	SupportCaseSeverity,
	SupportCaseStatus,
	SupportCaseType,
} from "@repo/support/enums";
import { aiUsageLedger, organization, user } from "./db-schema";
import type { getServiceDb } from "./db";

type Db = ReturnType<typeof getServiceDb>;

/** USD micros → USD (the ledger snapshots real cost-of-serve in 1e-6 USD). */
const usd = sql<number>`coalesce(sum(${aiUsageLedger.cost_micros}), 0)::float8 / 1e6`;

/** The denormalized fields shared by every case-list row (renders without a per-row join). */
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

// ── AI spend rollups (cross-tenant, read-only) ──────────────────────────────────────────
// Staff FinOps view over the console-owned ai_usage_ledger: cost_micros (1e-6 USD) rolled up
// per org / per user / per model, plus a daily trend. All run on getServiceDb (RLS-bypass);
// the SUPPORT_STAFF_EMAILS allowlist behind Cloudflare Access is the wall.

/** One org's AI spend over the window (USD from cost_micros) + its action count. */
export interface OrgSpendRow {
	org_id: string | null;
	org_name: string | null;
	org_slug: string | null;
	usd: number;
	actions: number;
}

/** One user's AI spend over the window (USD) + owning-org context + action count. */
export interface UserSpendRow {
	user_id: string;
	user_name: string | null;
	user_email: string | null;
	org_id: string | null;
	org_name: string | null;
	usd: number;
	actions: number;
}

/** One model's share of AI spend over the window (USD) + token totals + action count. */
export interface ModelSpendRow {
	model: string | null;
	usd: number;
	actions: number;
}

/** One calendar day's total AI spend (USD) — the trend line. */
export interface SpendDayRow {
	day: string;
	usd: number;
}

/** The complete AI-spend dashboard payload for a window. */
export interface AiSpendRollup {
	from: string;
	to: string;
	totalUsd: number;
	perOrg: OrgSpendRow[];
	perUser: UserSpendRow[];
	perModel: ModelSpendRow[];
	daily: SpendDayRow[];
}

/** Per-ORG AI spend over [from, to), highest spend first (top `limit`). */
export async function aiSpendPerOrg(
	db: Db,
	from: Date,
	to: Date,
	limit = 50,
): Promise<OrgSpendRow[]> {
	return db
		.select({
			org_id: aiUsageLedger.org_id,
			org_name: organization.name,
			org_slug: organization.slug,
			usd,
			actions: sql<number>`count(*)::int`,
		})
		.from(aiUsageLedger)
		.leftJoin(organization, eq(organization.id, aiUsageLedger.org_id))
		.where(
			and(gte(aiUsageLedger.created_at, from), lt(aiUsageLedger.created_at, to)),
		)
		.groupBy(aiUsageLedger.org_id, organization.name, organization.slug)
		.orderBy(desc(usd))
		.limit(limit);
}

/** Per-USER AI spend over [from, to), highest spend first (top `limit`). */
export async function aiSpendPerUser(
	db: Db,
	from: Date,
	to: Date,
	limit = 50,
): Promise<UserSpendRow[]> {
	return db
		.select({
			user_id: aiUsageLedger.user_id,
			user_name: user.name,
			user_email: user.email,
			org_id: aiUsageLedger.org_id,
			org_name: organization.name,
			usd,
			actions: sql<number>`count(*)::int`,
		})
		.from(aiUsageLedger)
		.leftJoin(user, eq(user.id, aiUsageLedger.user_id))
		.leftJoin(organization, eq(organization.id, aiUsageLedger.org_id))
		.where(
			and(gte(aiUsageLedger.created_at, from), lt(aiUsageLedger.created_at, to)),
		)
		.groupBy(
			aiUsageLedger.user_id,
			user.name,
			user.email,
			aiUsageLedger.org_id,
			organization.name,
		)
		.orderBy(desc(usd))
		.limit(limit);
}

/** Per-MODEL AI spend over [from, to), highest spend first. */
export async function aiSpendPerModel(
	db: Db,
	from: Date,
	to: Date,
): Promise<ModelSpendRow[]> {
	return db
		.select({
			model: aiUsageLedger.model,
			usd,
			actions: sql<number>`count(*)::int`,
		})
		.from(aiUsageLedger)
		.where(
			and(gte(aiUsageLedger.created_at, from), lt(aiUsageLedger.created_at, to)),
		)
		.groupBy(aiUsageLedger.model)
		.orderBy(desc(usd));
}

/** Daily AI spend trend over [from, to) (only active days; the caller fills the axis). */
export async function aiSpendDaily(
	db: Db,
	from: Date,
	to: Date,
): Promise<SpendDayRow[]> {
	return db
		.select({
			day: sql<string>`to_char(date_trunc('day', ${aiUsageLedger.created_at}), 'YYYY-MM-DD')`,
			usd,
		})
		.from(aiUsageLedger)
		.where(
			and(gte(aiUsageLedger.created_at, from), lt(aiUsageLedger.created_at, to)),
		)
		.groupBy(sql`1`)
		.orderBy(asc(sql`1`));
}

/**
 * The full AI-spend rollup for a window — per-org, per-user, per-model, a daily trend, and
 * the window total — in one call (parallel queries). Read-only; cross-tenant.
 */
export async function aiSpendRollup(
	db: Db,
	from: Date,
	to: Date,
): Promise<AiSpendRollup> {
	const [perOrg, perUser, perModel, daily] = await Promise.all([
		aiSpendPerOrg(db, from, to),
		aiSpendPerUser(db, from, to),
		aiSpendPerModel(db, from, to),
		aiSpendDaily(db, from, to),
	]);
	const totalUsd = perModel.reduce((acc, r) => acc + r.usd, 0);
	return {
		from: from.toISOString(),
		to: to.toISOString(),
		totalUsd,
		perOrg,
		perUser,
		perModel,
		daily,
	};
}
