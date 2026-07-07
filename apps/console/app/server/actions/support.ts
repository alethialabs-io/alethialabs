"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Support-case server actions — the customer half of the help-desk. Cases are ORG-OWNED
// with tiered visibility: every action is guarded via authorizeQuiet, then scoped through
// withSupportScope (RLS to the active org; owners/admins with manage_support see ALL the
// org's cases, everyone else only the ones they opened). Staff answer out of band (Slack +
// the service-role ingest path); notifications here are best-effort so a failed email/Slack
// never fails the customer's submit or reply.

import { eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { auth } from "@/lib/auth";
import { authorizeQuiet } from "@/lib/authz/guard";
import { getAuthConfig } from "@/lib/config/auth";
import { withSupportScope } from "@/lib/support/scope";
import { supportCaseReads, supportCases, supportMessages } from "@/lib/db/schema";
import type { SupportCaseStatus } from "@/lib/db/schema/enums";
import {
	notifySupportInboxEmail,
	sendCaseClosedEmail,
	sendCaseCreatedAck,
	sendCaseReopenedEmail,
	sendCaseRepliedEmail,
	sendCaseResolvedEmail,
	wantsEmail,
} from "@/lib/email/support-email";
import {
	type CaseListItem,
	type CaseWithThread,
	getCaseWithThread,
	listCasesForOwner,
	type PublicMessage,
} from "@/lib/queries/support";
import { globalHref } from "@/lib/routing";
import { slackCaseCreated, slackCaseReplied } from "@/lib/support/slack-notify";
import {
	type PostMessageInput,
	postMessageSchema,
	type SubmitCaseInput,
	submitCaseSchema,
} from "@/lib/validations/support";
import {
	assertTransition,
	caseLabel,
	nextStatusAfterCustomerReply,
} from "@/lib/support/case-status";
import type { AlertSeverity } from "@/lib/db/schema/enums";
import type { SupportCase } from "@/lib/db/schema";
import type { SupportContactPrefs } from "@/types/jsonb.types";
import { getActiveOrgSlug } from "./resolve";

/** The session user's display name + email, for the message author snapshot. */
async function sessionAuthor(): Promise<{ name: string; email: string }> {
	const session = await auth.api.getSession({ headers: await headers() });
	const user = session?.user;
	return {
		name: user?.name || user?.email || "Customer",
		email: user?.email ?? "",
	};
}

/**
 * Absolute console deep link to a case — `${baseURL}/{orgSlug}/~/support/cases/{id}`.
 * The route is keyed by the case UUID (not the number); the org slug is resolved from
 * the caller's active session (personal orgs fall back to `~` inside getActiveOrgSlug).
 */
async function caseUrl(caseId: string): Promise<string> {
	const base = getAuthConfig().baseURL?.replace(/\/$/, "") ?? "";
	const slug = await getActiveOrgSlug();
	return `${base}${globalHref(slug, `support/cases/${caseId}`)}`;
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
 * Emits a `system.support.case.*` org-observability event (Layer B) so admins can route
 * case activity to their configured alert channels. Fire-and-forget — never blocks the
 * customer action. Distinct from the transactional participant emails (Layer A).
 */
function emitCaseEvent(
	orgId: string,
	event: "opened" | "replied" | "resolved" | "reopened" | "closed",
	args: { caseId: string; caseNumber: number; subject: string; url: string; severity?: AlertSeverity },
): void {
	const titles: Record<typeof event, string> = {
		opened: `Support case ${caseLabel(args.caseNumber)} opened`,
		replied: `New reply on support case ${caseLabel(args.caseNumber)}`,
		resolved: `Support case ${caseLabel(args.caseNumber)} resolved`,
		reopened: `Support case ${caseLabel(args.caseNumber)} reopened`,
		closed: `Support case ${caseLabel(args.caseNumber)} closed`,
	};
	emitAlertEventSafe(orgId, `system.support.case.${event}`, {
		title: titles[event],
		summary: args.subject,
		severity: args.severity ?? (event === "reopened" ? "warning" : "info"),
		resource_type: "support_case",
		resource_id: args.caseId,
		link: args.url,
	});
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

	const created = await withSupportScope(actor, async (tx) => {
		const [row] = await tx
			.insert(supportCases)
			.values({
				user_id: actor.userId,
				org_id: actor.orgId,
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

	const url = await caseUrl(created.id);
	// Layer A — customer ack (respect the channel choice + CC list).
	if (wantsEmail(contact)) {
		await safeNotify("case-created ack", () =>
			sendCaseCreatedAck(contact.notifyEmail, {
				caseNumber: created.case_number,
				subject: data.subject,
				url,
				cc: contact.ccEmails,
			}),
		);
	}
	// Vendor inbox (Alethia's own help-desk) — email + env Slack webhook.
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
	// Layer B — org-observability event (admins route via their alert channels).
	emitCaseEvent(actor.orgId, "opened", {
		caseId: created.id,
		caseNumber: created.case_number,
		subject: data.subject,
		url,
	});

	return { id: created.id, caseNumber: created.case_number };
}

/** Lists the caller's cases (newest activity first), optionally by lifecycle bucket. */
export async function listMyCases(filter?: {
	status?: "active" | "resolved";
}): Promise<CaseListItem[]> {
	const actor = await authorizeQuiet("view", { type: "support_case" });
	return withSupportScope(actor, (tx) =>
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
	return withSupportScope(actor, async (tx) => {
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

	const result = await withSupportScope(actor, async (tx) => {
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

	const url = await caseUrl(data.caseId);
	// A customer reply notifies the vendor's help-desk inbox (email + Slack).
	const supportInbox = process.env.SUPPORT_EMAIL || "support@alethialabs.io";
	await safeNotify("case-reply email", () =>
		sendCaseRepliedEmail(supportInbox, {
			caseNumber: result.caseNumber,
			author: author.name,
			snippet: data.body.slice(0, 500),
			url,
			audience: "inbox",
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
	// Layer B — org-observability event.
	emitCaseEvent(actor.orgId, "replied", {
		caseId: data.caseId,
		caseNumber: result.caseNumber,
		subject: result.subject,
		url,
	});

	return { id: result.id };
}

/** The case fields a transition loads so its notifications can address the customer. */
interface TransitionResult {
	caseNumber: number;
	subject: string;
	contact: SupportContactPrefs;
	orgId: string;
}

/**
 * Updates a case's status through an owner-scoped, transition-checked write, returning
 * the case's number/subject/contact so the caller can notify the participant.
 */
async function transitionCase(
	id: string,
	to: SupportCaseStatus,
	extra: Partial<Pick<typeof supportCases.$inferInsert, "resolved_at" | "closed_at">> = {},
): Promise<TransitionResult> {
	const actor = await authorizeQuiet("reply", { type: "support_case", id });
	const info = await withSupportScope(actor, async (tx) => {
		const [caseRow] = await tx
			.select({
				status: supportCases.status,
				case_number: supportCases.case_number,
				subject: supportCases.subject,
				contact: supportCases.contact,
			})
			.from(supportCases)
			.where(eq(supportCases.id, id))
			.limit(1);
		if (!caseRow) throw new Error("Case not found");
		assertTransition(caseRow.status, to);
		await tx
			.update(supportCases)
			.set({ status: to, updated_at: sql`now()`, ...extra })
			.where(eq(supportCases.id, id));
		return caseRow;
	});
	return {
		caseNumber: info.case_number,
		subject: info.subject,
		contact: info.contact,
		orgId: actor.orgId,
	};
}

/** Marks a case resolved (stamps resolved_at) + notifies the customer. */
export async function resolveCase(id: string): Promise<void> {
	const { caseNumber, subject, contact, orgId } = await transitionCase(id, "resolved", {
		resolved_at: new Date(),
	});
	const url = await caseUrl(id);
	if (wantsEmail(contact)) {
		await safeNotify("case-resolved email", () =>
			sendCaseResolvedEmail(contact.notifyEmail, {
				caseNumber,
				url,
				cc: contact.ccEmails,
			}),
		);
	}
	emitCaseEvent(orgId, "resolved", { caseId: id, caseNumber, subject, url });
}

/** Reopens a resolved/closed case back to `open` + notifies the customer. */
export async function reopenCase(id: string): Promise<void> {
	const { caseNumber, subject, contact, orgId } = await transitionCase(id, "open");
	const url = await caseUrl(id);
	if (wantsEmail(contact)) {
		await safeNotify("case-reopened email", () =>
			sendCaseReopenedEmail(contact.notifyEmail, {
				caseNumber,
				url,
				cc: contact.ccEmails,
			}),
		);
	}
	emitCaseEvent(orgId, "reopened", { caseId: id, caseNumber, subject, url });
}

/** Closes a case (stamps closed_at) + notifies the customer. */
export async function closeCase(id: string): Promise<void> {
	const { caseNumber, subject, contact, orgId } = await transitionCase(id, "closed", {
		closed_at: new Date(),
	});
	const url = await caseUrl(id);
	if (wantsEmail(contact)) {
		await safeNotify("case-closed email", () =>
			sendCaseClosedEmail(contact.notifyEmail, {
				caseNumber,
				url,
				cc: contact.ccEmails,
			}),
		);
	}
	emitCaseEvent(orgId, "closed", { caseId: id, caseNumber, subject, url });
}

/** Advances the caller's read watermark for a case (unread badge clearing). */
export async function markCaseRead(id: string): Promise<void> {
	const actor = await authorizeQuiet("view", { type: "support_case", id });
	await withSupportScope(actor, async (tx) => {
		await tx
			.insert(supportCaseReads)
			.values({ case_id: id, user_id: actor.userId, last_read_at: new Date() })
			.onConflictDoUpdate({
				target: [supportCaseReads.case_id, supportCaseReads.user_id],
				set: { last_read_at: new Date() },
			});
	});
}
