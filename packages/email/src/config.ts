// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { env } from "next-runtime-env";

/** AWS SES credentials/region. Explicit keys are optional — the AWS default
 * credential chain (IAM role / AWS_* env) resolves them when omitted. */
export interface SesConfig {
	region: string;
	accessKeyId?: string;
	secretAccessKey?: string;
}

/** Per-stream from-addresses. Streams are isolated on dedicated sending
 * subdomains so a reputation hit on one never poisons another. */
export interface EmailFromAddresses {
	/** Auth/security stream — sign-in codes, verification, password reset. */
	auth: string;
	/** Product/general stream — welcome, org invites, notifications. */
	general: string;
}

export interface EmailConfig {
	/** SES config; null → emails are logged (dev), not sent. */
	ses: SesConfig | null;
	from: EmailFromAddresses;
}

let cached: EmailConfig | undefined;

/**
 * Transactional email config (AWS SES). SES is enabled once a region is set;
 * with none, sign-in/notify emails are logged to the console (dev) so a fresh
 * self-hoster works with zero email setup. Sender addresses are split by stream
 * (auth.* vs mail.*) — see docs/self-hosting/email.
 */
export function getEmailConfig(): EmailConfig {
	if (cached) return cached;

	const region = env("ALETHIA_SES_REGION") || env("AWS_REGION");
	const authFrom =
		env("AUTH_EMAIL_FROM") || "Alethia <no-reply@auth.alethialabs.io>";
	// General stream falls back to the auth address until a separate one is set.
	const generalFrom = env("EMAIL_FROM") || authFrom;

	cached = {
		ses: region
			? {
					region,
					accessKeyId: env("ALETHIA_SES_ACCESS_KEY_ID") || undefined,
					secretAccessKey: env("ALETHIA_SES_SECRET_ACCESS_KEY") || undefined,
				}
			: null,
		from: { auth: authFrom, general: generalFrom },
	};
	return cached;
}
