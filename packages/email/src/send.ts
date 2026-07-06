// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { render } from "@react-email/components";
import MailComposer from "nodemailer/lib/mail-composer";
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

/** A file to attach to the email (e.g. a Stripe-hosted invoice PDF). */
export interface EmailAttachment {
	/** Downloaded filename shown to the recipient, e.g. `Invoice-2026-0001.pdf`. */
	filename: string;
	/** Raw bytes of the file. */
	content: Uint8Array | Buffer;
	/** MIME type; defaults to `application/octet-stream` when omitted. */
	contentType?: string;
}

export interface SendEmailArgs {
	/** Verified SES from-address for this stream (getEmailConfig().from.*). */
	from: string;
	to: string;
	/** Optional CC recipients (e.g. a case author's ccEmails list). */
	cc?: string[];
	subject: string;
	/** react-email element, rendered to HTML. */
	react: ReactElement;
	/** SES configuration set for this stream — attributes events to SNS and the
	 * stream's reputation. Optional (getEmailConfig().configSet.*). */
	configurationSetName?: string;
	/** Extra context logged in the dev (no-SES) fallback, e.g. an OTP code. */
	devLog?: string;
	/** Files to attach. When present the email is sent as raw MIME (multipart)
	 * instead of the simple HTML path — used for invoice/receipt PDFs. */
	attachments?: EmailAttachment[];
}

/**
 * Builds a full MIME message (multipart/mixed) with the rendered HTML plus any
 * attachments, using nodemailer's MailComposer. SES v2 only carries attachments
 * through `Content.Raw`, so this is the raw-MIME path; the no-attachment path
 * stays on `Content.Simple`.
 */
async function buildRawMime(args: {
	from: string;
	to: string;
	cc?: string[];
	subject: string;
	html: string;
	attachments: EmailAttachment[];
}): Promise<Uint8Array> {
	const mail = new MailComposer({
		from: args.from,
		to: args.to,
		...(args.cc?.length ? { cc: args.cc } : {}),
		subject: args.subject,
		html: args.html,
		attachments: args.attachments.map((a) => ({
			filename: a.filename,
			content: Buffer.from(a.content),
			contentType: a.contentType,
		})),
	});
	// SES v2 `Content.Raw.Data` must be a Uint8Array — passing a Node Buffer trips a
	// SerializationException ("Start of structure or map found where not expected").
	return await new Promise<Uint8Array>((resolve, reject) => {
		mail.compile().build((err, message) => {
			if (err) reject(err);
			else resolve(new Uint8Array(message));
		});
	});
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
	cc,
	subject,
	react,
	configurationSetName,
	devLog,
	attachments,
}: SendEmailArgs): Promise<void> {
	const { ses } = getEmailConfig();

	if (!ses) {
		console.warn(
			`[email] SES not configured — "${subject}" → ${to}` +
				(cc?.length ? ` [cc: ${cc.join(", ")}]` : "") +
				(attachments?.length ? ` [+${attachments.length} attachment(s)]` : "") +
				(devLog ? ` (${devLog})` : ""),
		);
		return;
	}

	const html = await render(react);

	try {
		// With attachments we must send raw MIME (SES Simple content can't carry
		// files); without, the simpler Simple path keeps existing sends unchanged.
		const command =
			attachments && attachments.length > 0
				? new SendEmailCommand({
						FromEmailAddress: from,
						Destination: {
							ToAddresses: [to],
							...(cc?.length ? { CcAddresses: cc } : {}),
						},
						...(configurationSetName
							? { ConfigurationSetName: configurationSetName }
							: {}),
						Content: {
							Raw: {
								Data: await buildRawMime({
									from,
									to,
									cc,
									subject,
									html,
									attachments,
								}),
							},
						},
					})
				: new SendEmailCommand({
						FromEmailAddress: from,
						Destination: {
							ToAddresses: [to],
							...(cc?.length ? { CcAddresses: cc } : {}),
						},
						...(configurationSetName
							? { ConfigurationSetName: configurationSetName }
							: {}),
						Content: {
							Simple: {
								Subject: { Data: subject, Charset: "UTF-8" },
								Body: { Html: { Data: html, Charset: "UTF-8" } },
							},
						},
					});
		await sesClient(ses).send(command);
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
