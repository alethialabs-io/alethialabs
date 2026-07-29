// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONSENT_COOKIE,
	CONSENT_EVENT,
	CONSENT_VERSION,
	readConsent,
	writeConsent,
} from "@repo/privacy/consent";

describe("privacy consent record", () => {
	beforeEach(() => {
		document.cookie = `${CONSENT_COOKIE}=; Path=/; Max-Age=0`;
	});

	it("defaults to no optional-telemetry decision", () => {
		expect(readConsent()).toBeNull();
	});

	it("persists independent analytics and replay choices", () => {
		const listener = vi.fn();
		window.addEventListener(CONSENT_EVENT, listener);

		const record = writeConsent({ analytics: true, replay: false });

		expect(record).toMatchObject({
			version: CONSENT_VERSION,
			analytics: true,
			replay: false,
		});
		expect(readConsent()).toEqual(record);
		expect(listener).toHaveBeenCalledOnce();

		window.removeEventListener(CONSENT_EVENT, listener);
	});

	it("fails closed for malformed or obsolete records", () => {
		document.cookie = `${CONSENT_COOKIE}=${encodeURIComponent(
			JSON.stringify({
				version: CONSENT_VERSION + 1,
				analytics: true,
				replay: true,
				decidedAt: new Date().toISOString(),
			}),
		)}; Path=/`;

		expect(readConsent()).toBeNull();
	});
});
