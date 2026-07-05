// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Support-case transactional emails. Mirrors notify-email.ts: product/general stream,
// suppression-aware via sendGuardedEmail. Covers the customer-facing ack/reply/resolved
// notifications plus the internal "new case" ping to the support inbox.

import { getAuthConfig } from "@/lib/config/auth";
import { getEmailConfig } from "@repo/email/config";
import { sendGuardedEmail } from "./guard";
import {
	SupportCaseCreatedEmail,
	subject as createdSubject,
} from "@/emails/support-case-created";
import {
	SupportCaseReplyEmail,
	subject as replySubject,
} from "@/emails/support-case-reply";
import {
	SupportCaseResolvedEmail,
	subject as resolvedSubject,
} from "@/emails/support-case-resolved";

/** The inbox new-case notifications go to (override via SUPPORT_EMAIL). */
const DEFAULT_SUPPORT_EMAIL = "support@alethialabs.io";

/** Builds an absolute console deep link from the configured auth base URL. */
function consoleUrl(path: string): string {
	const base = getAuthConfig().baseURL?.replace(/\/$/, "") ?? "";
	return `${base}${path}`;
}

/** The console path for a single support case. */
function casePath(caseNumber: number): string {
	return `/support/cases/${caseNumber}`;
}

/**
 * Customer acknowledgement that a support case was opened. Sent on the general stream,
 * suppression-aware. `url` overrides the derived deep link when provided.
 */
export async function sendCaseCreatedAck(
	to: string,
	args: { caseNumber: number; subject: string; url?: string },
): Promise<void> {
	const config = getEmailConfig();
	const url = args.url ?? consoleUrl(casePath(args.caseNumber));
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		subject: createdSubject(args.caseNumber, args.subject),
		react: SupportCaseCreatedEmail({
			caseNumber: args.caseNumber,
			caseSubject: args.subject,
			url,
		}),
	});
}

/**
 * Notifies a recipient of a new reply on their case (a short snippet + a link back).
 * Used to email the support inbox when the customer replies.
 */
export async function sendCaseRepliedEmail(
	to: string,
	args: { caseNumber: number; author: string; snippet: string; url?: string },
): Promise<void> {
	const config = getEmailConfig();
	const url = args.url ?? consoleUrl(casePath(args.caseNumber));
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		subject: replySubject(args.caseNumber),
		react: SupportCaseReplyEmail({
			caseNumber: args.caseNumber,
			author: args.author,
			snippet: args.snippet,
			url,
		}),
	});
}

/** Notifies the customer that their case was marked resolved. */
export async function sendCaseResolvedEmail(
	to: string,
	args: { caseNumber: number; url?: string },
): Promise<void> {
	const config = getEmailConfig();
	const url = args.url ?? consoleUrl(casePath(args.caseNumber));
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		subject: resolvedSubject(args.caseNumber),
		react: SupportCaseResolvedEmail({ caseNumber: args.caseNumber, url }),
	});
}

/**
 * Internal "new case" notification to the support inbox (SUPPORT_EMAIL, default
 * support@alethialabs.io). Best-effort — call sites swallow failures so it never fails
 * the customer's submit. Reuses the reply template to carry the case subject + link.
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
	const url = args.url ?? consoleUrl(casePath(args.caseNumber));
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
		}),
	});
}
