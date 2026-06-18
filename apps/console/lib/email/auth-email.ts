// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Resend } from "resend";
import { getAuthConfig } from "@/lib/config/auth";
import {
	ConfirmationCodeEmail,
	subject as confirmationSubject,
} from "@/emails/confirmation-code";

/**
 * Sends the 6-digit sign-in code email via Resend, rendering the existing
 * `ConfirmationCodeEmail` react-email template. When RESEND_API_KEY is unset
 * (local/dev), the code is logged to the server console instead of sent — so a
 * fresh self-hoster can sign in with email OTP without configuring email first.
 */
export async function sendSignInCodeEmail(
	to: string,
	code: string,
	expiryMinutes = 10,
): Promise<void> {
	const { resendApiKey, emailFrom } = getAuthConfig();

	if (!resendApiKey) {
		console.warn(
			`[auth] RESEND_API_KEY unset — sign-in code for ${to}: ${code} ` +
				`(set RESEND_API_KEY to deliver this by email).`,
		);
		return;
	}

	const resend = new Resend(resendApiKey);
	const { error } = await resend.emails.send({
		from: emailFrom,
		to,
		subject: confirmationSubject,
		react: ConfirmationCodeEmail({ code, expiryMinutes }),
	});

	if (error) {
		throw new Error(`Failed to send sign-in code email: ${error.message}`);
	}
}
