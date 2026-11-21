// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Customer-facing staff notification emails. Thin senders over @repo/email/send (SES)
// using the shared @repo/support case templates. These fire when a STAFF agent
// replies to / assigns / transitions a case, so the customer hears back on the general
// (product) stream. Every one goes through `sendGuardedEmail` below, which skips an address
// on the console's suppression list exactly as the console's own senders do
// (apps/console/lib/email/guard.ts): a hard-bounced or complained address is not mailed again
// because a staff member, rather than the product, triggered the message.

import { eq } from "drizzle-orm";
import { getEmailConfig } from "@repo/email/config";
import { sendEmail, type SendEmailArgs } from "@repo/email/send";
import { getServiceDb } from "@/lib/db";
import { emailSuppression } from "@/lib/db-schema";
import type { SupportContactPrefs } from "@repo/support/types";
import {
	SupportCaseAssignedEmail,
	subject as assignedSubject,
} from "@repo/support/emails/support-case-assigned";
import {
	SupportCaseClosedEmail,
	subject as closedSubject,
} from "@repo/support/emails/support-case-closed";
import {
	SupportCaseReopenedEmail,
	subject as reopenedSubject,
} from "@repo/support/emails/support-case-reopened";
import {
	SupportCaseReplyEmail,
	subject as replySubject,
} from "@repo/support/emails/support-case-reply";
import {
	SupportCaseResolvedEmail,
	subject as resolvedSubject,
} from "@repo/support/emails/support-case-resolved";

/** True when the address is on the suppression list (the key is trimmed and lower-cased). */
export async function isSuppressed(email: string): Promise<boolean> {
	const [row] = await getServiceDb()
		.select({ email: emailSuppression.email })
		.from(emailSuppression)
		.where(eq(emailSuppression.email, email.trim().toLowerCase()))
		.limit(1);
	return row !== undefined;
}

/**
 * Sends one email unless its recipient is suppressed, and drops suppressed CC addresses. The
 * admin app's twin of the console's `sendGuardedEmail`; every sender in this module uses it.
 */
export async function sendGuardedEmail(args: SendEmailArgs): Promise<void> {
	if (await isSuppressed(args.to)) {
		console.warn(`[email] skipped "${args.subject}" (recipient suppressed)`);
		return;
	}
	const cc = args.cc?.length
		? (
				await Promise.all(
					args.cc.map(async (addr) => ((await isSuppressed(addr)) ? null : addr)),
				)
			).filter((addr): addr is string => addr !== null)
		: undefined;
	await sendEmail({ ...args, cc: cc?.length ? cc : undefined });
}

/**
 * Whether the customer wants email for a case, per their stored contact prefs. When they
 * chose the in-app channel we suppress transactional email. Undefined prefs default to
 * email (opt-out, not opt-in).
 */
export function wantsEmail(contact?: SupportContactPrefs | null): boolean {
	return contact?.channel !== "in_app";
}

/** Notifies the customer of a new staff reply on their case (a snippet + a link back). */
export async function sendStaffReplyEmail(
	to: string,
	args: {
		caseNumber: number;
		author: string;
		snippet: string;
		url: string;
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
			audience: "customer",
		}),
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
