// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getEmailConfig } from "@repo/email/config";
import { sendGuardedEmail } from "./guard";
import {
	ConfirmationCodeEmail,
	subject as confirmationSubject,
} from "@/emails/confirmation-code";
import {
	NoAccountEmail,
	subject as noAccountSubject,
} from "@/emails/no-account";

/**
 * Sends the 6-digit sign-in code from the auth/security stream
 * (no-reply@auth.*). When SES is unconfigured the code is logged (dev) — the
 * same zero-manual fallback as before.
 */
export async function sendSignInCodeEmail(
	to: string,
	code: string,
	expiryMinutes = 10,
): Promise<void> {
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.auth,
		configurationSetName: config.configSet.auth,
		to,
		subject: confirmationSubject,
		react: ConfirmationCodeEmail({ code, expiryMinutes }),
		devLog: `sign-in code: ${code}`,
	});
}

/**
 * Sent when a sign-in code is requested for an address with no account — instead
 * of silently creating one, we point the person to sign up. Auth/security stream.
 */
export async function sendNoAccountEmail(
	to: string,
	signupUrl: string,
): Promise<void> {
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.auth,
		configurationSetName: config.configSet.auth,
		to,
		subject: noAccountSubject,
		react: NoAccountEmail({ email: to, signupUrl }),
		devLog: `no account for ${to}`,
	});
}
