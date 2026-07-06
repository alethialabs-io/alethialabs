// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Support-case transactional emails. Mirrors notify-email.ts: product/general stream,
// suppression-aware via sendGuardedEmail. Covers the customer-facing
// ack/reply/resolved/reopened/closed/assigned notifications plus the internal "new
// case" ping to the support inbox. The `url` for a case is resolved by the caller
// (app/server/actions/support.ts caseUrl) so every link deep-links to the real case.

import { getAuthConfig } from "@/lib/config/auth";
import type { SupportContactPrefs } from "@/types/jsonb.types";
import { getEmailConfig } from "@repo/email/config";
import { sendGuardedEmail } from "./guard";
import {
	SupportCaseAssignedEmail,
	subject as assignedSubject,
} from "@/emails/support-case-assigned";
import {
	SupportCaseClosedEmail,
	subject as closedSubject,
} from "@/emails/support-case-closed";
import {
	SupportCaseCreatedEmail,
	subject as createdSubject,
} from "@/emails/support-case-created";
import {
	type ReplyAudience,
	SupportCaseReplyEmail,
	subject as replySubject,
} from "@/emails/support-case-reply";
import {
	SupportCaseReopenedEmail,
	subject as reopenedSubject,
} from "@/emails/support-case-reopened";
import {
	SupportCaseResolvedEmail,
	subject as resolvedSubject,
} from "@/emails/support-case-resolved";

/** The inbox new-case notifications go to (override via SUPPORT_EMAIL). */
const DEFAULT_SUPPORT_EMAIL = "support@alethialabs.io";

/**
 * Whether the customer wants email for a case, per their stored contact prefs. When
 * they chose the in-app channel we suppress transactional email — the notification bell
 * + toast still deliver it in-console. Undefined prefs default to email (opt-out, not in).
 */
export function wantsEmail(contact?: SupportContactPrefs | null): boolean {
	return contact?.channel !== "in_app";
}

/** Builds an absolute console deep link from the configured auth base URL. */
function consoleUrl(path: string): string {
	const base = getAuthConfig().baseURL?.replace(/\/$/, "") ?? "";
	return `${base}${path}`;
}

/**
 * Customer acknowledgement that a support case was opened. Sent on the general stream,
 * suppression-aware. `url` is the resolved case deep link; `cc` the case's ccEmails.
 */
export async function sendCaseCreatedAck(
	to: string,
	args: { caseNumber: number; subject: string; url: string; cc?: string[] },
): Promise<void> {
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		cc: args.cc,
		subject: createdSubject(args.caseNumber, args.subject),
		react: SupportCaseCreatedEmail({
			caseNumber: args.caseNumber,
			caseSubject: args.subject,
			url: args.url,
		}),
	});
}

/**
 * Notifies a recipient of a new reply on a case (a short snippet + a link back).
 * `audience: "customer"` = a staff reply reaching the case author; `"inbox"` = the
 * vendor's help-desk being pinged. `cc` applies to the customer audience only.
 */
export async function sendCaseRepliedEmail(
	to: string,
	args: {
		caseNumber: number;
		author: string;
		snippet: string;
		url: string;
		audience?: ReplyAudience;
		cc?: string[];
	},
): Promise<void> {
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		cc: args.cc,
		subject: replySubject(args.caseNumber),
		react: SupportCaseReplyEmail({
			caseNumber: args.caseNumber,
			author: args.author,
			snippet: args.snippet,
			url: args.url,
			audience: args.audience ?? "customer",
		}),
	});
}

/** Notifies the customer that their case was marked resolved. */
export async function sendCaseResolvedEmail(
	to: string,
	args: { caseNumber: number; url: string; cc?: string[] },
): Promise<void> {
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		cc: args.cc,
		subject: resolvedSubject(args.caseNumber),
		react: SupportCaseResolvedEmail({ caseNumber: args.caseNumber, url: args.url }),
	});
}

/** Notifies the customer that their case was reopened. */
export async function sendCaseReopenedEmail(
	to: string,
	args: { caseNumber: number; url: string; cc?: string[] },
): Promise<void> {
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		cc: args.cc,
		subject: reopenedSubject(args.caseNumber),
		react: SupportCaseReopenedEmail({ caseNumber: args.caseNumber, url: args.url }),
	});
}

/** Notifies the customer that their case was closed. */
export async function sendCaseClosedEmail(
	to: string,
	args: { caseNumber: number; url: string; cc?: string[] },
): Promise<void> {
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		cc: args.cc,
		subject: closedSubject(args.caseNumber),
		react: SupportCaseClosedEmail({ caseNumber: args.caseNumber, url: args.url }),
	});
}

/** Notifies the customer that an agent picked up their case. */
export async function sendCaseAssignedEmail(
	to: string,
	args: { caseNumber: number; agentName?: string; url: string; cc?: string[] },
): Promise<void> {
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		cc: args.cc,
		subject: assignedSubject(args.caseNumber),
		react: SupportCaseAssignedEmail({
			caseNumber: args.caseNumber,
			agentName: args.agentName,
			url: args.url,
		}),
	});
}

/**
 * Internal "new case / new activity" notification to the support inbox (SUPPORT_EMAIL,
 * default support@alethialabs.io). Best-effort — call sites swallow failures so it never
 * fails the customer's action. Reuses the reply template (inbox audience) for the link.
 */
export async function notifySupportInboxEmail(args: {
	caseNumber: number;
	subject: string;
	severity: string;
	orgId?: string;
	url?: string;
}): Promise<void> {
	const config = getEmailConfig();
	const to = process.env.SUPPORT_EMAIL || DEFAULT_SUPPORT_EMAIL;
	const url = args.url ?? consoleUrl(`/support/cases/${args.caseNumber}`);
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		subject: `[CASE-${String(args.caseNumber).padStart(6, "0")}] New ${args.severity} case: ${args.subject}`,
		react: SupportCaseReplyEmail({
			caseNumber: args.caseNumber,
			author: "New case",
			snippet: `${args.subject}${args.orgId ? `\n\norg: ${args.orgId}` : ""}`,
			url,
			audience: "inbox",
		}),
	});
}
