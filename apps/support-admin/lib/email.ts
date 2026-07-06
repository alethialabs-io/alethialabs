// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Customer-facing staff notification emails. Thin senders over @repo/email/send (SES)
// using the shared @repo/support case templates. These fire when a STAFF agent
// replies to / assigns / transitions a case, so the customer hears back on the general
// (product) stream. Unlike the console's lib/email/support-email.ts these call sendEmail
// directly — there is no DB suppression guard here, which is acceptable for the internal,
// low volume of staff-driven notifications.
// TODO: if volume grows, route through a shared suppression-aware guard like the console's.

import { getEmailConfig } from "@repo/email/config";
import { sendEmail } from "@repo/email/send";
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
	await sendEmail({
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
	await sendEmail({
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
	await sendEmail({
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
	await sendEmail({
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
	await sendEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		cc: args.cc,
		subject: closedSubject(args.caseNumber),
		react: SupportCaseClosedEmail({ caseNumber: args.caseNumber, url: args.url }),
	});
}
