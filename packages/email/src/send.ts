// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { render } from "@react-email/components";
import type { ReactElement } from "react";
import { getEmailConfig, type SesConfig } from "./config";

let cachedClient: SESv2Client | undefined;

/** Builds (once) the SES client. Explicit creds when given, else the AWS chain. */
function sesClient(ses: SesConfig): SESv2Client {
	if (cachedClient) return cachedClient;
	cachedClient = new SESv2Client({
		region: ses.region,
		...(ses.accessKeyId && ses.secretAccessKey
			? {
					credentials: {
						accessKeyId: ses.accessKeyId,
						secretAccessKey: ses.secretAccessKey,
					},
				}
			: {}),
	});
	return cachedClient;
}

export interface SendEmailArgs {
	/** Verified SES from-address for this stream (getEmailConfig().from.*). */
	from: string;
	to: string;
	subject: string;
	/** react-email element, rendered to HTML. */
	react: ReactElement;
	/** Extra context logged in the dev (no-SES) fallback, e.g. an OTP code. */
	devLog?: string;
}

/**
 * Sends one transactional email via AWS SES, rendering the react-email template
 * to HTML. When SES is unconfigured (no region — local/dev) it logs instead of
 * sending, so a fresh self-hoster works with zero email setup. Shared by every
 * stream (auth, product) — callers pass the stream's from-address.
 */
export async function sendEmail({
	from,
	to,
	subject,
	react,
	devLog,
}: SendEmailArgs): Promise<void> {
	const { ses } = getEmailConfig();

	if (!ses) {
		console.warn(
			`[email] SES not configured — "${subject}" → ${to}` +
				(devLog ? ` (${devLog})` : ""),
		);
		return;
	}

	const html = await render(react);

	try {
		await sesClient(ses).send(
			new SendEmailCommand({
				FromEmailAddress: from,
				Destination: { ToAddresses: [to] },
				Content: {
					Simple: {
						Subject: { Data: subject, Charset: "UTF-8" },
						Body: { Html: { Data: html, Charset: "UTF-8" } },
					},
				},
			}),
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// In dev, don't lose the email when SES fails (e.g. sandbox mode rejects
		// unverified recipients) — log it (incl. the OTP via devLog) so the code is
		// still retrievable from `pnpm dev:logs`. Production surfaces the error.
		if (process.env.NODE_ENV !== "production") {
			console.warn(
				`[email] SES send failed (dev) — "${subject}" → ${to}` +
					(devLog ? ` (${devLog})` : "") +
					`: ${message}`,
			);
			return;
		}
		throw new Error(`Failed to send "${subject}" via SES: ${message}`);
	}
}
