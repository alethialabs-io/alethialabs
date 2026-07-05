"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Support-case server actions — the customer half of the help-desk. Every action is
// guarded via authorizeQuiet (RLS scopes the writes through withOwnerScope). Staff
// answer out of band (Slack + the service-role ingest path); notifications here are
// best-effort so a failed email/Slack never fails the customer's submit or reply.

import { eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { authorizeQuiet } from "@/lib/authz/guard";
import { getAuthConfig } from "@/lib/config/auth";
import { withOwnerScope } from "@/lib/db";
import { supportCaseReads, supportCases, supportMessages } from "@/lib/db/schema";
import type { SupportCaseStatus } from "@/lib/db/schema/enums";
import {
	notifySupportInboxEmail,
	sendCaseCreatedAck,
	sendCaseRepliedEmail,
} from "@/lib/email/support-email";
import {
	type CaseListItem,
	type CaseWithThread,
	getCaseWithThread,
	listCasesForOwner,
	type PublicMessage,
} from "@/lib/queries/support";
import { slackCaseCreated, slackCaseReplied } from "@/lib/support/slack-notify";
import {
	type PostMessageInput,
	postMessageSchema,
	type SubmitCaseInput,
	submitCaseSchema,
} from "@/lib/validations/support";
import type { SupportCase } from "@/lib/db/schema";

/**
 * Legal status transitions. Each key lists the statuses a case may move to from that
 * state (self-transitions included so idempotent updates pass). Enforced by
 * {@link assertTransition}; illegal jumps throw.
 */
const TRANSITIONS: Record<SupportCaseStatus, SupportCaseStatus[]> = {
	open: ["open", "pending_support", "resolved", "closed"],
	pending_support: ["pending_support", "resolved", "closed"],
	pending_customer: ["pending_customer", "pending_support", "resolved", "closed"],
	resolved: ["resolved", "open", "pending_support", "closed"],
	closed: ["closed", "open", "pending_support"],
};

/** Throws when `to` is not a legal successor of `from`. */
function assertTransition(from: SupportCaseStatus, to: SupportCaseStatus): void {
	if (!TRANSITIONS[from].includes(to)) {
		throw new Error(`Illegal support-case transition: ${from} → ${to}`);
	}
}

/** The status a case advances to when the customer replies (reopens a settled case). */
function nextStatusAfterCustomerReply(
	current: SupportCaseStatus,
): SupportCaseStatus {
	if (
		current === "resolved" ||
		current === "closed" ||
		current === "pending_customer"
	) {
		return "pending_support";
	}
	return current;
}

/** The session user's display name + email, for the message author snapshot. */
async function sessionAuthor(): Promise<{ name: string; email: string }> {
	const session = await auth.api.getSession({ headers: await headers() });
	const user = session?.user;
	return {
		name: user?.name || user?.email || "Customer",
		email: user?.email ?? "",
	};
}

/** Absolute console deep link to a case (used in notifications). */
function caseUrl(caseNumber: number): string {
	const base = getAuthConfig().baseURL?.replace(/\/$/, "") ?? "";
	return `${base}/support/cases/${caseNumber}`;
}

/** Runs a best-effort notification, logging (never throwing) on failure. */
async function safeNotify(label: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (err) {
		console.warn(`[support] ${label} failed:`, err);
	}
}

/**
 * Opens a new support case: inserts the case plus its first (customer) thread message,
 * then fires the acknowledgement email + Slack/inbox notifications best-effort. Returns
 * the new case's id and human-facing case number.
 */
export async function submitCase(
	input: SubmitCaseInput,
): Promise<{ id: string; caseNumber: number }> {
	const data = submitCaseSchema.parse(input);
	const actor = await authorizeQuiet("create", { type: "support_case" });
	const author = await sessionAuthor();

	// The submit form always supplies contact prefs; the Ask-AI escalation path omits
	// them, so default to the session user's email + in-console channel.
	const contact = data.contact ?? {
		notifyEmail: author.email,
		channel: "email" as const,
	};

	const created = await withOwnerScope(actor.userId, async (tx) => {
		const [row] = await tx
			.insert(supportCases)
			.values({
				user_id: actor.userId,
				org_id: actor.userId,
				type: data.type,
				category: data.category,
				severity: data.severity ?? "normal",
				status: "open",
				subject: data.subject,
				context: data.context ?? {},
				contact,
				abuse: data.abuse ?? null,
				last_author_type: "customer",
			})
			.returning({ id: supportCases.id, case_number: supportCases.case_number });

		await tx.insert(supportMessages).values({
			case_id: row.id,
			author_type: "customer",
			author_id: actor.userId,
			author_name: author.name,
			body: data.description,
		});

		return row;
	});

	const url = caseUrl(created.case_number);
	await safeNotify("case-created ack", () =>
		sendCaseCreatedAck(contact.notifyEmail, {
			caseNumber: created.case_number,
			subject: data.subject,
			url,
		}),
	);
	await safeNotify("case-created Slack", () =>
		slackCaseCreated({
			caseNumber: created.case_number,
			subject: data.subject,
			severity: data.severity ?? "normal",
			orgId: actor.orgId,
			url,
		}),
	);
	await safeNotify("case-created inbox", () =>
		notifySupportInboxEmail({
			caseNumber: created.case_number,
			subject: data.subject,
			severity: data.severity ?? "normal",
			orgId: actor.orgId,
			url,
		}),
	);

	return { id: created.id, caseNumber: created.case_number };
}

/** Lists the caller's cases (newest activity first), optionally by lifecycle bucket. */
export async function listMyCases(filter?: {
	status?: "active" | "resolved";
}): Promise<CaseListItem[]> {
	const actor = await authorizeQuiet("view", { type: "support_case" });
	return withOwnerScope(actor.userId, (tx) =>
		listCasesForOwner(tx, actor.userId, filter ?? {}),
	);
}

/**
 * Loads one case with its customer-visible thread + attachments, and advances the
 * caller's read watermark. Returns null when the case isn't visible.
 */
export async function getCase(id: string): Promise<{
	case: SupportCase;
	messages: PublicMessage[];
	attachments: CaseWithThread["attachments"];
} | null> {
	const actor = await authorizeQuiet("view", { type: "support_case", id });
	return withOwnerScope(actor.userId, async (tx) => {
		const result = await getCaseWithThread(tx, id);
		if (!result) return null;
		await tx
			.insert(supportCaseReads)
			.values({ case_id: id, user_id: actor.userId, last_read_at: new Date() })
			.onConflictDoUpdate({
				target: [supportCaseReads.case_id, supportCaseReads.user_id],
				set: { last_read_at: new Date() },
			});
		return result;
	});
}

/**
 * Posts a customer reply on a case: inserts the message, bumps last_message_at /
 * last_author_type, and advances a settled case back to `pending_support`. Notifies
 * support (email + Slack) best-effort. Returns the new message id.
 */
export async function postCaseMessage(
	input: PostMessageInput,
): Promise<{ id: string }> {
	const data = postMessageSchema.parse(input);
	const actor = await authorizeQuiet("reply", {
		type: "support_case",
		id: data.caseId,
	});
	const author = await sessionAuthor();

	const result = await withOwnerScope(actor.userId, async (tx) => {
		const [caseRow] = await tx
			.select({
				case_number: supportCases.case_number,
				subject: supportCases.subject,
				severity: supportCases.severity,
				status: supportCases.status,
			})
			.from(supportCases)
			.where(eq(supportCases.id, data.caseId))
			.limit(1);
		if (!caseRow) throw new Error("Case not found");

		const nextStatus = nextStatusAfterCustomerReply(caseRow.status);
		assertTransition(caseRow.status, nextStatus);

		const [msg] = await tx
			.insert(supportMessages)
			.values({
				case_id: data.caseId,
				author_type: "customer",
				author_id: actor.userId,
				author_name: author.name,
				body: data.body,
			})
			.returning({ id: supportMessages.id });

		await tx
			.update(supportCases)
			.set({
				last_message_at: sql`now()`,
				last_author_type: "customer",
				status: nextStatus,
				updated_at: sql`now()`,
			})
			.where(eq(supportCases.id, data.caseId));

		return {
			id: msg.id,
			caseNumber: caseRow.case_number,
			subject: caseRow.subject,
			severity: caseRow.severity,
		};
	});

	const url = caseUrl(result.caseNumber);
	const supportInbox = process.env.SUPPORT_EMAIL || "support@alethialabs.io";
	await safeNotify("case-reply email", () =>
		sendCaseRepliedEmail(supportInbox, {
			caseNumber: result.caseNumber,
			author: author.name,
			snippet: data.body.slice(0, 500),
			url,
		}),
	);
	await safeNotify("case-reply Slack", () =>
		slackCaseReplied({
			caseNumber: result.caseNumber,
			subject: result.subject,
			severity: result.severity,
			orgId: actor.orgId,
			url,
		}),
	);

	return { id: result.id };
}

/** Updates a case's status through an owner-scoped, transition-checked write. */
async function transitionCase(
	id: string,
	to: SupportCaseStatus,
	extra: Partial<Pick<typeof supportCases.$inferInsert, "resolved_at" | "closed_at">> = {},
): Promise<void> {
	const actor = await authorizeQuiet("reply", { type: "support_case", id });
	await withOwnerScope(actor.userId, async (tx) => {
		const [caseRow] = await tx
			.select({ status: supportCases.status })
			.from(supportCases)
			.where(eq(supportCases.id, id))
			.limit(1);
		if (!caseRow) throw new Error("Case not found");
		assertTransition(caseRow.status, to);
		await tx
			.update(supportCases)
			.set({ status: to, updated_at: sql`now()`, ...extra })
			.where(eq(supportCases.id, id));
	});
}

/** Marks a case resolved (stamps resolved_at). */
export async function resolveCase(id: string): Promise<void> {
	await transitionCase(id, "resolved", { resolved_at: new Date() });
}

/** Reopens a resolved/closed case back to `open`. */
export async function reopenCase(id: string): Promise<void> {
	await transitionCase(id, "open");
}

/** Closes a case (stamps closed_at). */
export async function closeCase(id: string): Promise<void> {
	await transitionCase(id, "closed", { closed_at: new Date() });
}

/** Advances the caller's read watermark for a case (unread badge clearing). */
export async function markCaseRead(id: string): Promise<void> {
	const actor = await authorizeQuiet("view", { type: "support_case", id });
	await withOwnerScope(actor.userId, async (tx) => {
		await tx
			.insert(supportCaseReads)
			.values({ case_id: id, user_id: actor.userId, last_read_at: new Date() })
			.onConflictDoUpdate({
				target: [supportCaseReads.case_id, supportCaseReads.user_id],
				set: { last_read_at: new Date() },
			});
	});
}
