// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * Consent v2 — necessary storage, and ONE optional choice.
 *
 * v1 carried a second choice, `replay`, for masked session replay. Session replay is disabled as a
 * product decision, so the choice is gone rather than merely defaulted off: a control that offers a
 * purpose nobody runs is a false statement about what the product does.
 *
 * The version is in the COOKIE NAME, not only in the payload. A v1 cookie is therefore never read,
 * never migrated, and is actively deleted on the next read — see `readConsent`.
 */
export const CONSENT_COOKIE = "alethia_consent_v2";

/** The v1 cookie, kept only so it can be deleted. Never read for a decision. */
const LEGACY_CONSENT_COOKIE = "alethia_consent_v1";

export const CONSENT_EVENT = "alethia:consent";
export const CONSENT_VERSION = 2;
const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 183;

export const consentPreferencesSchema = z.object({
	analytics: z.boolean(),
});

export const consentRecordSchema = consentPreferencesSchema.extend({
	version: z.literal(CONSENT_VERSION),
	decidedAt: z.string().datetime(),
});

export type ConsentPreferences = z.infer<typeof consentPreferencesSchema>;
export type ConsentRecord = z.infer<typeof consentRecordSchema>;

/**
 * Is Global Privacy Control asserted by this browser?
 *
 * GPC is a legally recognised opt-out signal in several jurisdictions, and it is an OPT-OUT — so it
 * is read as a standing refusal, not as a default that a later click can overturn. `analyticsAllowed`
 * is where that is enforced; nothing else should read this directly.
 *
 * The property is not in every browser's lib.dom, so it is read off Navigator without widening the
 * global type and without a cast (this repo's lint refuses `as`).
 */
export function globalPrivacyControlEnabled(): boolean {
	if (typeof navigator === "undefined") return false;
	const value = Object.getOwnPropertyDescriptor(
		Object.getPrototypeOf(navigator) ?? navigator,
		"globalPrivacyControl",
	)?.get?.call(navigator);
	if (typeof value === "boolean") return value;
	// Some browsers/extensions set it as a plain own property rather than a prototype accessor.
	const own: unknown = Object.getOwnPropertyDescriptor(navigator, "globalPrivacyControl")?.value;
	return own === true;
}

/**
 * The single place that decides whether optional analytics may run.
 *
 * Every consumer asks THIS, never `record.analytics`. Reading the field directly is how a surface
 * ends up honouring the stored choice but not the browser's opt-out signal — a divergence nobody
 * notices, because the common case looks identical.
 */
export function analyticsAllowed(record: ConsentRecord | null): boolean {
	if (globalPrivacyControlEnabled()) return false;
	return record?.analytics === true;
}

/**
 * Read and validate the first-party consent record from document.cookie.
 *
 * A v1 cookie is not a v2 decision — it recorded a choice across two purposes, one of which no
 * longer exists, so there is no honest way to project it onto v2. Promoting `analytics: true` from
 * it would be inventing consent for a policy the person never saw. It is deleted here instead, and
 * the first-visit notice shows again.
 */
export function readConsent(): ConsentRecord | null {
	if (typeof document === "undefined") return null;
	if (readCookie(LEGACY_CONSENT_COOKIE) !== undefined) deleteCookie(LEGACY_CONSENT_COOKIE);

	const encoded = readCookie(CONSENT_COOKIE);
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

/** One cookie's raw value, or undefined when absent. */
function readCookie(name: string): string | undefined {
	return document.cookie
		.split("; ")
		.find((item) => item.startsWith(`${name}=`))
		?.slice(name.length + 1);
}

/** Expire a cookie on the path it was written with. */
function deleteCookie(name: string): void {
	document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/**
 * PostHog's own browser storage keys, cleared when analytics consent is withdrawn.
 *
 * `posthog.reset()` clears the distinct id but leaves its cookie and localStorage entries in place,
 * so a withdrawal that only calls reset() leaves the identifiers on the device. The requirement is
 * that identifiers are DELETED, not that capture stops, so both happen — see the console's
 * AnalyticsProvider.
 *
 * Keys are matched by prefix because PostHog namespaces them per project key (`ph_<key>_posthog`).
 */
export const POSTHOG_STORAGE_PREFIX = "ph_";

/**
 * Delete PostHog's identifiers and storage from this device.
 *
 * Deliberately independent of the posthog-js instance: on withdrawal the library may never have been
 * loaded in this document (a person who accepted, reloaded away, and came back to withdraw), and the
 * identifiers still have to go. Safe to call when nothing is stored.
 */
export function purgePostHogStorage(): void {
	if (typeof window === "undefined") return;
	for (const store of [window.localStorage, window.sessionStorage]) {
		try {
			for (const key of Object.keys(store)) {
				if (key.startsWith(POSTHOG_STORAGE_PREFIX)) store.removeItem(key);
			}
		} catch {
			// Storage can throw in a private window or when site data is blocked. A device we cannot
			// read is a device we cannot be leaving identifiers on.
		}
	}
	if (typeof document === "undefined") return;
	for (const item of document.cookie.split("; ")) {
		const name = item.split("=")[0];
		if (name?.startsWith(POSTHOG_STORAGE_PREFIX)) deleteCookie(name);
	}
}
