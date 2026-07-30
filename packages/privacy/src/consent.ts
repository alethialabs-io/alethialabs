// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

export const CONSENT_COOKIE = "alethia_consent_v1";
export const CONSENT_EVENT = "alethia:consent";
export const CONSENT_VERSION = 1;
const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 183;

export const consentPreferencesSchema = z.object({
	analytics: z.boolean(),
	replay: z.boolean(),
});

export const consentRecordSchema = consentPreferencesSchema.extend({
	version: z.literal(CONSENT_VERSION),
	decidedAt: z.string().datetime(),
});

export type ConsentPreferences = z.infer<typeof consentPreferencesSchema>;
export type ConsentRecord = z.infer<typeof consentRecordSchema>;

/** Read and validate the first-party consent record from document.cookie. */
export function readConsent(): ConsentRecord | null {
	if (typeof document === "undefined") return null;
	const encoded = document.cookie
		.split("; ")
		.find((item) => item.startsWith(`${CONSENT_COOKIE}=`))
		?.slice(CONSENT_COOKIE.length + 1);
	if (!encoded) return null;

	try {
		const parsed: unknown = JSON.parse(decodeURIComponent(encoded));
		const result = consentRecordSchema.safeParse(parsed);
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}

/** Persist a versioned consent decision as a first-party, path-wide cookie. */
export function writeConsent(preferences: ConsentPreferences): ConsentRecord {
	const record: ConsentRecord = {
		...preferences,
		version: CONSENT_VERSION,
		decidedAt: new Date().toISOString(),
	};
	const secure = window.location.protocol === "https:" ? "; Secure" : "";
	document.cookie = `${CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify(record))}; Path=/; Max-Age=${CONSENT_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
	window.dispatchEvent(new CustomEvent<ConsentRecord>(CONSENT_EVENT, { detail: record }));
	return record;
}
