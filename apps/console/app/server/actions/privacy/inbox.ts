// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where a self-serve privacy request goes, so that a person finds out it exists (#4875).
//
// A `privacy_case` row reaches nobody by itself: nothing lists the table, and no job watches its
// `due_at`. So a request the subject opens from the console is also EMAILED to the privacy inbox.
//
// Not a `"use server"` module: its exports are called by server actions, never by the browser, and
// a browser that could call `notifyPrivacyInbox` could send the privacy inbox anything it liked.

import "server-only";
import { deploymentMode } from "@/lib/billing/config";
import { PrivacyRequestEmail, subject } from "@/emails/privacy-request";
import { getEmailConfig } from "@repo/email/config";
import { sendEmail } from "@repo/email/send";

/** The inbox the hosted service's privacy requests go to, as `docs/legal/PRIVACY_REQUEST_RUNBOOK.md` names it. */
const HOSTED_PRIVACY_EMAIL = "privacy@alethialabs.io";

/**
 * The address a privacy request is sent to, or `null` when this deployment has none.
 *
 * `PRIVACY_EMAIL` wins when it is set. Without it, the hosted service uses Alethia's own privacy
 * inbox. A SELF-MANAGED deployment gets `null`, not Alethia's inbox: there the operator is the
 * controller of its users' data, and sending their erasure requests to the vendor would hand a
 * third party personal data it has no business receiving. `null` means "nobody would be told", and
 * the caller must then open no case.
 */
export function privacyInbox(): string | null {
	const configured = process.env.PRIVACY_EMAIL?.trim();
	if (configured) return configured;
	return deploymentMode() === "hosted" ? HOSTED_PRIVACY_EMAIL : null;
}

/**
 * Emails the privacy inbox about a new erasure request. In a production build a failed send throws,
 * so a caller that runs this inside the case's transaction rolls the case back with it.
 *
 * Two cases where `@repo/email` logs the message instead of sending it, both as it does for every
 * other email: with no mail provider configured (the console log is then where a deployment without
 * mail also delivers its sign-in codes), and a failed send in a NON-production build. On the hosted
 * service `getEmailConfig` refuses a missing provider outside the sandbox (`packages/email/src/
 * config.ts`), so in hosted production a missing provider throws here instead of dropping the
 * message.
 */
export async function notifyPrivacyInbox(
	to: string,
	request: {
		reference: string;
		subjectUserId: string;
		subjectEmail: string;
		receivedAt: Date;
		dueAt: Date;
	},
): Promise<void> {
	const receivedAt = request.receivedAt.toISOString();
	const dueAt = request.dueAt.toISOString();
	await sendEmail({
		from: getEmailConfig().from.general,
		to,
		subject: subject(request.reference, dueAt),
		react: PrivacyRequestEmail({
			reference: request.reference,
			subjectUserId: request.subjectUserId,
			subjectEmail: request.subjectEmail,
			receivedAt,
			dueAt,
		}),
		devLog: `erasure request ${request.reference} for user ${request.subjectUserId}`,
	});
}
