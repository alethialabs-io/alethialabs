// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { CONSENT_COOKIE_NAME, DEVICE_STORAGE } from "@repo/legal/processing";
import {
	analyticsAllowed,
	CONSENT_COOKIE,
	CONSENT_VERSION,
	consentRecordSchema,
	globalPrivacyControlEnabled,
	purgePostHogStorage,
	readConsent,
	writeConsent,
} from "@repo/privacy/consent";

/** Remove every cookie this suite may have written, so cases cannot leak into each other. */
function clearCookies(): void {
	for (const item of document.cookie.split("; ")) {
		const name = item.split("=")[0];
		if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
	}
}

/** Assert Global Privacy Control for one test, and restore the browser afterwards. */
function withGPC(value: boolean): void {
	Object.defineProperty(navigator, "globalPrivacyControl", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	clearCookies();
	localStorage.clear();
	sessionStorage.clear();
	Reflect.deleteProperty(navigator, "globalPrivacyControl");
	vi.restoreAllMocks();
});

describe("consent v2", () => {
	it("stores one optional choice and no replay field", () => {
		const record = writeConsent({ analytics: true });
		expect(record.version).toBe(2);
		expect(Object.keys(record).sort()).toEqual([
			"analytics",
			"decidedAt",
			"version",
		]);
		expect(readConsent()).toEqual(record);
	});

	// A v1 cookie recorded a choice across two purposes, one of which no longer exists. There is no
	// honest projection onto v2 — promoting `analytics: true` from it would be inventing consent for
	// a policy the person never saw — so it is discarded AND deleted, and the notice shows again.
	it("does not migrate a v1 cookie, and deletes it", () => {
		document.cookie = `alethia_consent_v1=${encodeURIComponent(
			JSON.stringify({
				analytics: true,
				replay: true,
				version: 1,
				decidedAt: new Date().toISOString(),
			}),
		)}; Path=/`;

		expect(readConsent()).toBeNull();
		expect(document.cookie).not.toContain("alethia_consent_v1");
	});

	it("rejects a record whose version is not 2", () => {
		expect(
			consentRecordSchema.safeParse({
				analytics: true,
				version: 1,
				decidedAt: new Date().toISOString(),
			}).success,
		).toBe(false);
	});

	it("returns null for a malformed cookie rather than throwing", () => {
		document.cookie = `${CONSENT_COOKIE}=not-json; Path=/`;
		expect(readConsent()).toBeNull();
	});
});

describe("Global Privacy Control", () => {
	it("keeps analytics off, overriding a stored yes", () => {
		const record = writeConsent({ analytics: true });
		expect(analyticsAllowed(record)).toBe(true);

		withGPC(true);
		expect(globalPrivacyControlEnabled()).toBe(true);
		// GPC is an opt-OUT signal: a stored "yes" must not overturn it. This is the whole reason
		// consumers ask analyticsAllowed() instead of reading record.analytics.
		expect(analyticsAllowed(record)).toBe(false);
	});

	it("is not asserted by its mere absence", () => {
		expect(globalPrivacyControlEnabled()).toBe(false);
		withGPC(false);
		expect(globalPrivacyControlEnabled()).toBe(false);
		expect(analyticsAllowed(writeConsent({ analytics: true }))).toBe(true);
	});

	it("never allows analytics with no decision at all", () => {
		expect(analyticsAllowed(null)).toBe(false);
		withGPC(true);
		expect(analyticsAllowed(null)).toBe(false);
	});
});

describe("purgePostHogStorage", () => {
	// The requirement is that identifiers are DELETED on withdrawal, not that capture stops.
	// posthog.reset() clears the distinct id but leaves the cookie and localStorage entries behind,
	// so a withdrawal that only calls reset() leaves the identifiers on the device.
	it("deletes PostHog keys from local storage, session storage and cookies", () => {
		localStorage.setItem("ph_phc_test_posthog", '{"distinct_id":"abc"}');
		localStorage.setItem("ph_phc_test_posthog_dedupe", "1");
		sessionStorage.setItem("ph_phc_test_window_id", "w");
		localStorage.setItem("unrelated", "keep");
		document.cookie = "ph_phc_test_posthog=abc; Path=/";

		purgePostHogStorage();

		expect(localStorage.getItem("ph_phc_test_posthog")).toBeNull();
		expect(localStorage.getItem("ph_phc_test_posthog_dedupe")).toBeNull();
		expect(sessionStorage.getItem("ph_phc_test_window_id")).toBeNull();
		expect(document.cookie).not.toContain("ph_phc_test_posthog");
		// Only PostHog's own namespace goes.
		expect(localStorage.getItem("unrelated")).toBe("keep");
	});

	it("is safe when nothing is stored", () => {
		expect(() => purgePostHogStorage()).not.toThrow();
	});

	it("survives storage that throws (private window, blocked site data)", () => {
		vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		localStorage.setItem("ph_x", "1");
		expect(() => purgePostHogStorage()).not.toThrow();
	});
});

describe("the public device-storage disclosure", () => {
	// @repo/legal cannot import @repo/privacy (it is the leaf both apps read, and the privacy package
	// is client-side React), so the cookie name is stated in two places. It went stale exactly that
	// way once — the register named alethia_consent_v1 while browsers held v2, which is a disclosure
	// a reader cannot verify by opening devtools. This is the guard that replaces the import.
	it("names the cookie the browser actually receives", () => {
		expect(CONSENT_COOKIE_NAME).toBe(CONSENT_COOKIE);
		expect(CONSENT_COOKIE).toBe(`alethia_consent_v${CONSENT_VERSION}`);
		expect(DEVICE_STORAGE.map((entry) => entry.name)).toContain(CONSENT_COOKIE);
	});

	it("discloses only necessary storage — the optional choice stores nothing extra", () => {
		expect(DEVICE_STORAGE.every((entry) => entry.category === "necessary")).toBe(
			true,
		);
	});
});
