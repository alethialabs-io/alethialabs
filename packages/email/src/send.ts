// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { render } from "@react-email/components";
import { createTransport, type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import type { ReactElement } from "react";
import {
	getEmailConfig,
	type EmailConfig,
	type SesConfig,
	type SmtpConfig,
} from "./config";

let cachedSesClient: SESv2Client | undefined;
let cachedSmtp: Transporter | undefined;

/** Builds (once) the SES client. Explicit creds when given, else the AWS chain. */
function sesClient(ses: SesConfig): SESv2Client {
	if (cachedSesClient) return cachedSesClient;
	cachedSesClient = new SESv2Client({
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
	return cachedSesClient;
}

/** Builds (once) the nodemailer SMTP transport. */
function smtpTransport(smtp: SmtpConfig): Transporter {
	if (cachedSmtp) return cachedSmtp;
	cachedSmtp = createTransport({
		host: smtp.host,
		port: smtp.port,
		secure: smtp.secure,
		...(smtp.user && smtp.pass
			? { auth: { user: smtp.user, pass: smtp.pass } }
			: {}),
	});
	return cachedSmtp;
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
	/** Verified from-address for this stream (getEmailConfig().from.*). */
	from: string;
	to: string;
	/** Optional CC recipients (e.g. a case author's ccEmails list). */
	cc?: string[];
	subject: string;
	/** react-email element, rendered to HTML. */
	react: ReactElement;
	/** SES configuration set for this stream — attributes events to SNS and the
	 * stream's reputation. SES only; ignored by SMTP (which isolates streams
	 * by sending subdomain). Optional (getEmailConfig().configSet.*). */
	configurationSetName?: string;
	/** Extra context logged in the dev (no-provider) fallback, e.g. an OTP code. */
	devLog?: string;
	/** Files to attach. When present the email is sent as raw MIME (multipart)
	 * instead of the simple HTML path — used for invoice/receipt PDFs. */
	attachments?: EmailAttachment[];
}

/** The rendered, provider-agnostic message a transport sends. */
interface RenderedMessage {
	from: string;
	to: string;
	cc?: string[];
	subject: string;
	html: string;
}

/**
 * Builds a full MIME message (multipart/mixed) with the rendered HTML plus any
 * attachments, using nodemailer's MailComposer. SES v2 only carries attachments
 * through `Content.Raw`, so this is the raw-MIME path; the no-attachment path
 * stays on `Content.Simple`. (SMTP takes attachments natively.)
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

/** Sends the rendered email via a generic SMTP server (nodemailer). */
async function sendViaSmtp(
	config: EmailConfig,
	msg: RenderedMessage,
	attachments: EmailAttachment[] | undefined,
): Promise<void> {
	await smtpTransport(config.smtp!).sendMail({
		from: msg.from,
		to: msg.to,
		...(msg.cc?.length ? { cc: msg.cc } : {}),
		subject: msg.subject,
		html: msg.html,
		...(attachments?.length
			? {
					attachments: attachments.map((a) => ({
						filename: a.filename,
						content: Buffer.from(a.content),
						...(a.contentType ? { contentType: a.contentType } : {}),
					})),
				}
			: {}),
	});
}

/** Sends the rendered email via AWS SES v2 (Simple, or Raw when attachments). */
async function sendViaSes(
	config: EmailConfig,
	msg: RenderedMessage,
	configurationSetName: string | undefined,
	attachments: EmailAttachment[] | undefined,
): Promise<void> {
	const { from, to, cc, subject, html } = msg;
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
	await sesClient(config.ses!).send(command);
}

/** Matches an email address, so a provider error that echoes a recipient is logged without it. */
const EMAIL_ADDRESS = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[^\s@<>"'(),;:]+/g;

/**
 * Writes one structured (JSON) error line for a failed send, in every environment.
 *
 * Before this, a failed SES send surfaced only as the Error thrown to the caller — and most callers
 * run inside a Better Auth background task or a fire-and-forget notifier that swallows it, so a
 * rejected send left no line anyone could alert on. The line names the transport, the stream's
 * configuration set and the provider's own error name/code (an AWS SDK error carries `name`, e.g.
 * `MessageRejected`, and `$metadata.httpStatusCode`). It deliberately carries no recipient and no
 * subject (a subject can hold a sign-in code), and email addresses in the provider's message are
 * replaced, because SES echoes unverified identities back in it.
 *
 * packages/email has no error-reporting hook, so this is a log line, not a Sentry event.
 */
function logSendFailure(
	provider: string,
	configurationSetName: string | undefined,
	err: unknown,
): void {
	const httpStatus =
		typeof err === "object" &&
		err !== null &&
		"$metadata" in err &&
		typeof err.$metadata === "object" &&
		err.$metadata !== null &&
		"httpStatusCode" in err.$metadata &&
		typeof err.$metadata.httpStatusCode === "number"
			? err.$metadata.httpStatusCode
			: undefined;
	const code =
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(typeof err.code === "string" || typeof err.code === "number")
			? err.code
			: undefined;
	console.error(
		JSON.stringify({
			level: "error",
			time: new Date().toISOString(),
			msg: "email send failed",
			event: "email.send_failed",
			provider,
			...(configurationSetName ? { configuration_set: configurationSetName } : {}),
			err: {
				type: err instanceof Error ? err.name : typeof err,
				message: (err instanceof Error ? err.message : String(err)).replace(
					EMAIL_ADDRESS,
					"[email]",
				),
				...(code !== undefined ? { code } : {}),
				...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
			},
		}),
	);
}

/**
 * Sends one transactional email via the configured provider (SMTP or SES), rendering the react-email template to HTML. When no provider is
 * configured (local/dev) it logs instead of sending, so a fresh self-hoster
 * works with zero email setup. Shared by every stream (auth, product) — callers
 * pass the stream's from-address.
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
	const config = getEmailConfig();

	if (!config.provider) {
		console.warn(
			`[email] no provider configured — "${subject}" → ${to}` +
				(cc?.length ? ` [cc: ${cc.join(", ")}]` : "") +
				(attachments?.length ? ` [+${attachments.length} attachment(s)]` : "") +
				(devLog ? ` (${devLog})` : ""),
		);
		return;
	}

	const html = await render(react);
	const msg: RenderedMessage = { from, to, cc, subject, html };

	try {
		switch (config.provider) {
			case "smtp":
				await sendViaSmtp(config, msg, attachments);
				break;
			case "ses":
				await sendViaSes(config, msg, configurationSetName, attachments);
				break;
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logSendFailure(config.provider, configurationSetName, err);
		// In dev, don't lose the email when a send fails (e.g. SES sandbox rejects
		// unverified recipients, or a bad key) — log it (incl. the OTP via devLog)
		// so the code is still retrievable from `pnpm dev:logs`. Prod surfaces it.
		if (process.env.NODE_ENV !== "production") {
			console.warn(
				`[email] ${config.provider} send failed (dev) — "${subject}" → ${to}` +
					(devLog ? ` (${devLog})` : "") +
					`: ${message}`,
			);
			return;
		}
		throw new Error(
			`Failed to send "${subject}" via ${config.provider}: ${message}`,
		);
	}
}
