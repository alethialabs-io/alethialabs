// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { render } from "@react-email/components";
import { getAuthConfig } from "@/lib/config/auth";
import {
	ConfirmationCodeEmail,
	subject as confirmationSubject,
} from "@/emails/confirmation-code";

/**
 * Sends the 6-digit sign-in code email via AWS SES, rendering the existing
 * `ConfirmationCodeEmail` react-email template to HTML. When SES is not
 * configured (ALETHIA_SES_REGION unset — local/dev), the code is logged to the
 * server console instead of sent — so a fresh self-hoster can sign in with email
 * OTP without configuring email first.
 */
export async function sendSignInCodeEmail(
	to: string,
	code: string,
	expiryMinutes = 10,
): Promise<void> {
	const { ses, emailFrom } = getAuthConfig();

	if (!ses) {
		console.warn(
			`[auth] SES not configured (ALETHIA_SES_REGION unset) — sign-in code ` +
				`for ${to}: ${code} (set ALETHIA_SES_* to deliver this by email).`,
		);
		return;
	}

	const html = await render(ConfirmationCodeEmail({ code, expiryMinutes }));

	const client = new SESv2Client({
		region: ses.region,
		// Explicit creds when given; otherwise the SDK's default chain (IAM role / AWS_* env).
		...(ses.accessKeyId && ses.secretAccessKey
			? {
					credentials: {
						accessKeyId: ses.accessKeyId,
						secretAccessKey: ses.secretAccessKey,
					},
				}
			: {}),
	});

	try {
		await client.send(
			new SendEmailCommand({
				FromEmailAddress: emailFrom,
				Destination: { ToAddresses: [to] },
				Content: {
					Simple: {
						Subject: { Data: confirmationSubject, Charset: "UTF-8" },
						Body: { Html: { Data: html, Charset: "UTF-8" } },
					},
				},
			}),
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to send sign-in code email via SES: ${message}`);
	}
}
