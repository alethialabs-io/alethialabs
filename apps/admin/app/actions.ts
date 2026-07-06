"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Staff-side support actions — the cross-tenant write-path behind the admin
// dashboard. Every action gates on assertStaff() (the SUPPORT_STAFF_EMAILS allowlist
// behind Cloudflare Access is the trust boundary; staff aren't org members, so there's no
// PDP grant to check) and writes via getServiceDb() (RLS-bypass — staff act on every org's
// cases). Customer-facing side effects reuse the notifiers in lib/staff-notify.ts.

import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
	assertTransition,
	nextStatusAfterStaffReply,
} from "@repo/support/status";
import type {
	SupportCaseSeverity,
	SupportCaseStatus,
} from "@repo/support/enums";
import {
	supportCaseReads,
	supportCases,
	supportMessages,
} from "@repo/support/schema";
import { assertStaff } from "@/lib/auth/staff";
import { getServiceDb } from "@/lib/db";
import {
	getCaseWithThreadForStaff,
	listCasesForStaff,
	type StaffCaseDetail,
	type StaffCaseListItem,
} from "@/lib/queries";
import {
	notifyAssigned,
	notifyStaffReply,
	notifyStatusChange,
} from "@/lib/staff-notify";

/** The staff list filter as it arrives from the dashboard (mine = "assigned to me"). */
export interface StaffListInput {
	status?: SupportCaseStatus;
	severity?: SupportCaseSeverity;
	orgId?: string;
	mine?: boolean;
	search?: string;
}

/** A staff reply / internal note. */
const staffReplySchema = z.object({
	caseId: z.string().uuid(),
	body: z.string().min(1).max(10000),
	isInternal: z.boolean().default(false),
});
// The INPUT type — `isInternal` is optional at the call site (zod defaults it to false);
// `staffReplySchema.parse` yields the resolved output where it's a boolean.
export type StaffReplyInput = z.input<typeof staffReplySchema>;

/** Upserts the staff member's read watermark for a case (their own unread state). */
async function markRead(caseId: string, staffId: string): Promise<void> {
	const now = new Date();
	await getServiceDb()
		.insert(supportCaseReads)
		.values({ case_id: caseId, user_id: staffId, last_read_at: now })
		.onConflictDoUpdate({
			target: [supportCaseReads.case_id, supportCaseReads.user_id],
			set: { last_read_at: now },
		});
}

/** Lists cases across all orgs for the staff dashboard (filtered/searchable). */
export async function listStaffCases(
	filter: StaffListInput = {},
): Promise<StaffCaseListItem[]> {
	const staff = await assertStaff();
	return listCasesForStaff(getServiceDb(), staff.userId, {
		status: filter.status,
		severity: filter.severity,
		orgId: filter.orgId,
		assignedTo: filter.mine ? staff.userId : undefined,
		search: filter.search,
	});
}

/** Loads one case with its full thread (incl. internal notes) + advances the staff watermark. */
export async function getStaffCase(
	caseId: string,
): Promise<StaffCaseDetail | null> {
	const staff = await assertStaff();
	const result = await getCaseWithThreadForStaff(getServiceDb(), caseId);
	if (!result) return null;
	await markRead(caseId, staff.userId);
	return result;
}

/** Advances the staff member's read watermark for a case (clears its unread dot). */
export async function markStaffCaseRead(caseId: string): Promise<void> {
	const staff = await assertStaff();
	await markRead(caseId, staff.userId);
}

/**
 * Posts a staff reply on a case. A PUBLIC reply is inserted, moves the case to
 * `pending_customer`, and emails the customer (notifyStaffReply). An INTERNAL note is
 * inserted only (never emailed/shown to the customer, no status change) — but it still
 * appears live in the staff thread via the SSE trigger.
 */
export async function postStaffReply(
	input: StaffReplyInput,
): Promise<{ id: string }> {
	const data = staffReplySchema.parse(input);
	const staff = await assertStaff();
	const db = getServiceDb();

	const [caseRow] = await db
		.select({ status: supportCases.status })
		.from(supportCases)
		.where(eq(supportCases.id, data.caseId))
		.limit(1);
	if (!caseRow) throw new Error("Case not found");

	const [msg] = await db
		.insert(supportMessages)
		.values({
			case_id: data.caseId,
			author_type: "staff",
			author_id: staff.userId,
			author_name: staff.name,
			body: data.body,
			is_internal: data.isInternal,
		})
		.returning({ id: supportMessages.id });

	if (!data.isInternal) {
		const nextStatus = nextStatusAfterStaffReply();
		assertTransition(caseRow.status, nextStatus);
		await db
			.update(supportCases)
			.set({
				last_message_at: sql`now()`,
				last_author_type: "staff",
				status: nextStatus,
				updated_at: sql`now()`,
			})
			.where(eq(supportCases.id, data.caseId));

		await notifyStaffReply(data.caseId, {
			author: staff.name,
			snippet: data.body,
		});
	}

	return { id: msg.id };
}

/** Assigns a case to the acting staff member + tells the customer an agent is on it. */
export async function assignCaseToMe(caseId: string): Promise<void> {
	const staff = await assertStaff();
	await getServiceDb()
		.update(supportCases)
		.set({ assigned_staff_id: staff.userId, updated_at: sql`now()` })
		.where(eq(supportCases.id, caseId));
	await notifyAssigned(caseId, { agentName: staff.name });
}

/** Clears a case's assignee (no customer notification). */
export async function unassignCase(caseId: string): Promise<void> {
	await assertStaff();
	await getServiceDb()
		.update(supportCases)
		.set({ assigned_staff_id: null, updated_at: sql`now()` })
		.where(eq(supportCases.id, caseId));
}

/** Cross-tenant, transition-checked staff status write + customer notification. */
async function staffTransition(
	caseId: string,
	to: SupportCaseStatus,
	kind: "resolved" | "reopened" | "closed",
	extra: Partial<
		Pick<typeof supportCases.$inferInsert, "resolved_at" | "closed_at">
	> = {},
): Promise<void> {
	await assertStaff();
	const db = getServiceDb();
	const [caseRow] = await db
		.select({ status: supportCases.status })
		.from(supportCases)
		.where(eq(supportCases.id, caseId))
		.limit(1);
	if (!caseRow) throw new Error("Case not found");
	assertTransition(caseRow.status, to);
	await db
		.update(supportCases)
		.set({ status: to, updated_at: sql`now()`, ...extra })
		.where(eq(supportCases.id, caseId));
	await notifyStatusChange(caseId, kind);
}

/** Staff marks a case resolved (stamps resolved_at) + notifies the customer. */
export async function staffResolveCase(caseId: string): Promise<void> {
	await staffTransition(caseId, "resolved", "resolved", {
		resolved_at: new Date(),
	});
}

/** Staff reopens a resolved/closed case + notifies the customer. */
export async function staffReopenCase(caseId: string): Promise<void> {
	await staffTransition(caseId, "open", "reopened");
}

/** Staff closes a case (stamps closed_at) + notifies the customer. */
export async function staffCloseCase(caseId: string): Promise<void> {
	await staffTransition(caseId, "closed", "closed", { closed_at: new Date() });
}
