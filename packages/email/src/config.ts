// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { env } from "next-runtime-env";

/** AWS SES credentials/region. Explicit keys are optional — the AWS default
 * credential chain (IAM role / AWS_* env) resolves them when omitted. */
export interface SesConfig {
	region: string;
	accessKeyId?: string;
	secretAccessKey?: string;
}

/** Resend HTTP transport. It is temporary hosted-production infrastructure, not a permanent default. */
export interface ResendConfig {
	apiKey: string;
}

/** Generic SMTP transport (via nodemailer) — the universal self-host path, so a
 * self-hoster can bring any provider (Postmark, Mailgun, SES-SMTP, …). */
export interface SmtpConfig {
	host: string;
	port: number;
	user?: string;
	pass?: string;
	/** TLS on connect (implicit TLS, usually port 465). Defaults to `port === 465`. */
	secure: boolean;
}

/** Selected transactional-email transport. `null` (no provider configured) →
 * emails are logged to the console instead of sent. */
export type EmailProvider = "resend" | "smtp" | "ses";

/** Per-stream from-addresses. Streams are isolated on dedicated sending
 * subdomains so a reputation hit on one never poisons another. */
export interface EmailFromAddresses {
	/** Auth/security stream — sign-in codes, verification, password reset. */
	auth: string;
	/** Product/general stream — welcome, org invites, notifications. */
	general: string;
}

/** Per-stream SES configuration-set names. A send tagged with its set routes
 * bounce/complaint events to SNS and is counted under that stream's reputation.
 * Optional — undefined sends with no config set (today's behavior). SES only. */
export interface EmailConfigSets {
	auth?: string;
	general?: string;
}

export interface EmailConfig {
	/** Resolved transport; null → emails are logged (dev), not sent. */
	provider: EmailProvider | null;
	/** Resend config — present iff `provider === "resend"`. */
	resend?: ResendConfig;
	/** SMTP config — present iff `provider === "smtp"`. */
	smtp?: SmtpConfig;
	/** SES config — present iff `provider === "ses"`. */
	ses?: SesConfig;
	from: EmailFromAddresses;
	/** Per-stream configuration sets (SES only; see EmailConfigSets). */
	configSet: EmailConfigSets;
}

let cached: EmailConfig | undefined;

/** Reads a boolean-ish env var; undefined when unset so a default can apply. */
function envBool(name: string): boolean | undefined {
	const v = env(name);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

/**
 * Transactional email config (pluggable transport). The provider is chosen by
 * `EMAIL_PROVIDER` (resend | smtp | ses) when set, else inferred from whichever
 * provider's credentials are present (Resend → SMTP → SES). With none, emails
 * are logged to the console (dev) so a fresh self-hoster works with zero email
 * setup. Sender addresses are split by stream (auth.* vs mail.*) — see
 * docs/self-hosting/email.
 */
export function getEmailConfig(): EmailConfig {
	if (cached) return cached;

	// The fallback domain must be one the provider has VERIFIED. This used to default to
	// `no-reply@auth.alethialabs.io`, and a provider that verifies domains individually — Resend
	// does — rejects a subdomain whose parent is verified. So the fallback was a footgun: it looks
	// like a safe default and bounces every message, at send time, after everything upstream has
	// reported success. The apex is the address actually verified.
	const authFrom = env("AUTH_EMAIL_FROM") || "Alethia <no-reply@alethialabs.io>";
	// General stream falls back to the auth address until a separate one is set.
	const generalFrom = env("EMAIL_FROM") || authFrom;

	// Build each provider's config from whatever creds are present.
	const resendKey = env("RESEND_API_KEY");
	const resend: ResendConfig | undefined = resendKey
		? { apiKey: resendKey }
		: undefined;

	const smtpHost = env("SMTP_HOST");
	const smtpPort = Number(env("SMTP_PORT")) || 587;
	const smtp: SmtpConfig | undefined = smtpHost
		? {
				host: smtpHost,
				port: smtpPort,
				user: env("SMTP_USER") || undefined,
				pass: env("SMTP_PASS") || undefined,
				secure: envBool("SMTP_SECURE") ?? smtpPort === 465,
			}
		: undefined;

	const sesRegion = env("ALETHIA_SES_REGION") || env("AWS_REGION");
	const ses: SesConfig | undefined = sesRegion
		? {
				region: sesRegion,
				accessKeyId: env("ALETHIA_SES_ACCESS_KEY_ID") || undefined,
				secretAccessKey: env("ALETHIA_SES_SECRET_ACCESS_KEY") || undefined,
			}
		: undefined;

	// Resolve the transport: an explicit EMAIL_PROVIDER wins (but only if its
	// creds are actually present), else infer by precedence Resend → SMTP → SES.
	const explicit = env("EMAIL_PROVIDER")?.toLowerCase();
	let provider: EmailProvider | null = null;
	if (explicit === "resend" && resend) provider = "resend";
	else if (explicit === "smtp" && smtp) provider = "smtp";
	else if (explicit === "ses" && ses) provider = "ses";
	else if (!explicit) {
		if (resend) provider = "resend";
		else if (smtp) provider = "smtp";
		else if (ses) provider = "ses";
	}

	// Hosted deployments must not degrade transactional mail to the development log fallback.
	//
	// The SANDBOX carve-out below exists because that rule, keyed on `ALETHIA_DEPLOYMENT_MODE`
	// alone, made sign-in impossible on every sandbox branch env (#2953). `scripts/env.sh` mints
	// `hosted` so the sandbox rehearses hosted BILLING, and deliberately copies no mail
	// credential — so this threw inside a Better Auth background task, the send returned 200,
	// and the code was produced neither by mail nor by the log. Nothing was ever red.
	//
	// It needs BOTH conditions, which is what keeps it from being an escape hatch:
	//
	//   · ALETHIA_SANDBOX=1 — written only by scripts/env.sh. No deploy path writes it
	//     (deploy-console.yml mints its own env and does not), and no operator has a reason to.
	//   · NOT a production build. A real hosted deployment is one; the sandbox is not. So even
	//     if the flag leaked into a production environment, the carve-out stays shut.
	//
	// A single flag would have been an escape hatch on the one guard whose whole value is
	// refusing one. The conjunction is a statement about what the process IS, and a real
	// deployment cannot satisfy it.
	// Note the `!explicit`: the carve-out covers "no provider configured at all", which is what
	// a sandbox is. Naming a provider and then not supplying its credentials is a
	// misconfiguration in ANY environment, and logging instead of failing would hide it — so
	// that case still throws, sandbox or not.
	const sandboxDevFallback =
		env("ALETHIA_SANDBOX") === "1" &&
		process.env.NODE_ENV !== "production" &&
		!explicit;

	if (
		env("ALETHIA_DEPLOYMENT_MODE") === "hosted" &&
		!provider &&
		!sandboxDevFallback
	) {
		throw new Error(
			explicit
				? `EMAIL_PROVIDER=${explicit} is configured without matching credentials.`
				: "Hosted deployments require an explicit, credentialed EMAIL_PROVIDER.",
		);
	}

	cached = {
		provider,
		resend,
		smtp,
		ses,
		from: { auth: authFrom, general: generalFrom },
		configSet: {
			auth: env("ALETHIA_SES_AUTH_CONFIG_SET") || undefined,
			general: env("ALETHIA_SES_GENERAL_CONFIG_SET") || undefined,
		},
	};
	return cached;
}
