// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getEmailConfig } from "@repo/email/config";
import { sendEmail } from "@repo/email/send";
import {
	ConfirmationCodeEmail,
	subject as confirmationSubject,
} from "@/emails/confirmation-code";

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
	await sendEmail({
		from: getEmailConfig().from.auth,
		to,
		subject: confirmationSubject,
		react: ConfirmationCodeEmail({ code, expiryMinutes }),
		devLog: `sign-in code: ${code}`,
	});
}
